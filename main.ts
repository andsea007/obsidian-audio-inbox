import { Plugin, Notice, PluginSettingTab, App, Setting, requestUrl, normalizePath, TFile, Modal } from "obsidian";

// ==================== TYPES ====================

interface AudioInboxSettings {
	inboxFolder: string;
	outputFolder: string;
	sttApiUrl: string;
	sttApiKey: string;
	sttModel: string;
	sttLanguage: string;
	aiApiUrl: string;
	aiApiKey: string;
	aiModel: string;
	summaryPrompt: string;
	showTranscript: boolean;
}

const DEFAULTS: AudioInboxSettings = {
	inboxFolder: "录音",
	outputFolder: "VoiceNotes",
	sttApiUrl: "https://api.siliconflow.cn/v1/audio/transcriptions",
	sttApiKey: "",
	sttModel: "FunAudioLLM/SenseVoiceSmall",
	sttLanguage: "zh",
	aiApiUrl: "https://api.deepseek.com/v1/chat/completions",
	aiApiKey: "",
	aiModel: "deepseek-chat",
	summaryPrompt: `将以下录音文本总结为结构化 Markdown 笔记。

必须包含以下两个部分（缺一不可）：

## 📋 总结
用要点和编号列表组织内容，突出关键信息、决定、结论。简洁但完整。

## ✅ 待办事项
提取所有行动项、任务、承诺、约定。每个一行，用 - [ ] 开头。
如果没有任何待办，写「- [ ] 无」
格式举例：
- [ ] 明天下午3点开会
- [ ] 买牛奶和鸡蛋
- [ ] 周五前完成报告`,
	showTranscript: false,
};

// ==================== RECORDING MODAL ====================

class RecordModal extends Modal {
	private resolve: (blob: Blob | null) => void;
	private stream: MediaStream | null = null;
	private mediaRecorder: MediaRecorder | null = null;
	private audioChunks: Blob[] = [];
	private startTime = 0;
	private timerId: ReturnType<typeof setInterval> | null = null;
	private isFinished = false;
	private mimeType = "";
	private timerEl!: HTMLElement;

	constructor(app: App, resolve: (blob: Blob | null) => void) {
		super(app);
		this.resolve = resolve;
	}

	async onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("audio-inbox-modal");

		contentEl.createEl("h2", { text: "🎤 语音笔记" });

		// Timer + status
		const statusRow = contentEl.createDiv({ cls: "ai-modal-status" });
		const dot = statusRow.createSpan({ cls: "ai-dot" });
		this.timerEl = statusRow.createSpan({ cls: "ai-modal-timer", text: "00:00" });
		statusRow.createSpan({ text: " 录音中，请说话...", cls: "ai-modal-label" });

		// Buttons
		const btns = contentEl.createDiv({ cls: "ai-modal-btns" });
		const stopBtn = btns.createEl("button", { text: "⏹ 停止录音", cls: "ai-modal-stop" });

		// Get mic
		try {
			this.stream = await navigator.mediaDevices.getUserMedia({
				audio: { echoCancellation: true, noiseSuppression: true },
			});
		} catch (e) {
			contentEl.empty();
			contentEl.createEl("h3", { text: "❌ 无法访问麦克风" });
			contentEl.createEl("p", { text: "请在系统设置中允许 Obsidian 使用麦克风权限，然后重试。" });
			contentEl.createEl("p", { text: "💡 或者用 Obsidian 内置录音功能录制，保存到「录音」文件夹，再用 Ctrl+P「处理录音文件夹」功能。" });
			const closeBtn = contentEl.createEl("button", { text: "关闭", cls: "ai-modal-stop" });
			closeBtn.onclick = () => { this.isFinished = true; this.close(); };
			return;
		}

		// MediaRecorder
		this.mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
			? "audio/webm;codecs=opus" : "audio/webm";
		this.mediaRecorder = new MediaRecorder(this.stream, { mimeType: this.mimeType, audioBitsPerSecond: 64000 });
		this.mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) this.audioChunks.push(e.data); };
		this.mediaRecorder.onstop = () => { this.finish(); };
		this.audioChunks = [];
		this.mediaRecorder.start(250);

		// Timer
		this.startTime = Date.now();
		this.timerId = setInterval(() => {
			const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
			const m = Math.floor(elapsed / 60).toString().padStart(2, "0");
			const s = (elapsed % 60).toString().padStart(2, "0");
			this.timerEl.setText(`${m}:${s}`);
		}, 200);

		stopBtn.onclick = () => { this.doStop(); };
	}

	private doStop() {
		if (this.timerId) clearInterval(this.timerId);
		if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
			this.mediaRecorder.stop();
		} else {
			this.finish();
		}
	}

	private finish() {
		if (this.isFinished) return;
		this.isFinished = true;
		if (this.stream) this.stream.getTracks().forEach(t => t.stop());
		if (this.timerId) clearInterval(this.timerId);
		const blob = this.audioChunks.length > 0
			? new Blob(this.audioChunks, { type: this.mimeType || "audio/webm" })
			: null;
		this.resolve(blob);
		this.close();
	}

	onClose() {
		this.finish();
	}
}

// ==================== MAIN PLUGIN ====================

export default class AudioInboxPlugin extends Plugin {
	settings: AudioInboxSettings;
	private isBusy = false;
	private fabEl: HTMLElement | null = null;

	async onload() {
		await this.loadSettings();

		// Ribbon — main record button
		this.addRibbonIcon("mic", "语音笔记 — 开始录音", () => this.startRecordFlow());

		// Command — record
		this.addCommand({ id: "start-voice-record", name: "开始语音笔记（录音）", callback: () => this.startRecordFlow() });

		// Command — process inbox files
		this.addCommand({ id: "process-inbox", name: "处理录音文件夹", callback: () => this.processInbox() });

		// Settings
		this.addSettingTab(new AudioInboxSettingTab(this.app, this));

		// Floating button for mobile (big and hard to miss)
		this.addFab();
	}

	private addFab() {
		const isMobile = /iPhone|iPad|Android|Mobile/i.test(navigator.userAgent);
		if (!isMobile) return;

		const fab = document.body.createDiv({ cls: "ai-fab" });
		fab.createSpan({ text: "🎤", cls: "ai-fab-icon" });
		this.fabEl = fab;

		let dragging = false;
		let moved = false;
		let sx = 0, sy = 0, sl = 0, st = 0;

		// Only attach move/end to document DURING a drag
		const addListeners = () => {
			document.addEventListener("touchmove", onMove, { passive: false });
			document.addEventListener("touchend", onEnd);
			document.addEventListener("mousemove", onMove);
			document.addEventListener("mouseup", onEnd);
		};
		const removeListeners = () => {
			document.removeEventListener("touchmove", onMove);
			document.removeEventListener("touchend", onEnd);
			document.removeEventListener("mousemove", onMove);
			document.removeEventListener("mouseup", onEnd);
		};

		const onStart = (e: TouchEvent | MouseEvent) => {
			moved = false;
			const t = "touches" in e ? e.touches[0] : e;
			sx = t.clientX; sy = t.clientY;
			const r = fab.getBoundingClientRect();
			sl = r.left; st = r.top;
			addListeners();
		};

		const onMove = (e: TouchEvent | MouseEvent) => {
			const t = "touches" in e ? e.touches[0] : e;
			const dx = t.clientX - sx, dy = t.clientY - sy;
			if (Math.abs(dx) > 8 || Math.abs(dy) > 8) moved = true;
			if (!moved) return;
			e.preventDefault();
			dragging = true;
			fab.style.left = (sl + dx) + "px";
			fab.style.top = (st + dy) + "px";
			fab.style.right = "auto";
			fab.style.bottom = "auto";
		};

		const onEnd = () => {
			removeListeners();
			setTimeout(() => { dragging = false; moved = false; }, 50);
		};

		fab.addEventListener("touchstart", onStart, { passive: false });
		fab.addEventListener("mousedown", onStart);

		fab.addEventListener("click", () => {
			if (dragging || moved) return;
			if (this.isBusy) { new Notice("⏳ 正在处理中..."); return; }
			this.startRecordFlow();
		});

		// Re-inject if Obsidian mobile re-renders
		this.registerInterval(window.setInterval(() => {
			if (!document.body.contains(fab)) {
				document.body.appendChild(fab);
			}
		}, 3000));
	}

	async loadSettings() {
		const saved = await this.loadData();
		this.settings = Object.assign({}, DEFAULTS, saved || {});
		// Auto-migrate: if old prompt detected, replace with new one
		if (this.settings.summaryPrompt && this.settings.summaryPrompt.includes("5. 使用中文输出") && !this.settings.summaryPrompt.includes("待办事项")) {
			this.settings.summaryPrompt = DEFAULTS.summaryPrompt;
			await this.saveSettings();
		}
	}
	async saveSettings() { await this.saveData(this.settings); }

	// ===== MAIN FLOW: Record → STT → AI → Note =====

	async startRecordFlow() {
		if (this.isBusy) { new Notice("⏳ 正在处理中..."); return; }
		if (!this.settings.sttApiKey || !this.settings.aiApiKey) {
			new Notice("⚠️ 请先在设置中填入 STT 和 AI 的 API Key\n硅基流动 + DeepSeek 各一个 Key");
			return;
		}

		this.isBusy = true;
		const statusEl = this.addStatusBarItem();

		try {
			// 1. Record
			const blob = await new Promise<Blob | null>(resolve => {
				new RecordModal(this.app, resolve).open();
			});

			if (!blob) { new Notice("录音已取消"); return; }

			// 2. Save audio
			statusEl.setText("📁 保存录音...");
			const audioPath = await this.saveAudio(blob);

			// 3. STT (SiliconFlow free)
			statusEl.setText("🎧 语音转文字...");
			const transcript = await this.callSTT(blob);
			if (!transcript || transcript.trim().length < 2) {
				statusEl.setText("⚠️ 无结果");
				setTimeout(() => statusEl.remove(), 3000);
				new Notice(`⚠️ 未识别到语音\n📁 ${audioPath}\n💡 打开 Obsidian 开发者工具 (Ctrl+Shift+I) 查看 Console 日志，或检查 API Key 是否正确`);
				return;
			}

			// 4. AI summarize
			statusEl.setText("📝 AI 总结...");
			const summary = await this.callAI(transcript);

			// 5. Extract todos & save
			const todos = extractTodos(summary);
			await this.saveNote(audioPath, transcript, summary);
			if (todos.length > 0) {
				await this.saveTodos(todos);
			}

			statusEl.setText("✅ 完成");
			setTimeout(() => statusEl.remove(), 3000);
			new Notice(`✅ 语音笔记已生成`);

		} catch (err: any) {
			statusEl.setText("❌ 失败");
			setTimeout(() => statusEl.remove(), 5000);
			new Notice(`❌ ${err.message || err}`, 8000);
			console.error(err);
		} finally {
			this.isBusy = false;
		}
	}

	// ===== PROCESS INBOX (pre-recorded files) =====

	async processInbox() {
		if (this.isBusy) { new Notice("⏳ 正在处理中..."); return; }
		if (!this.settings.sttApiKey || !this.settings.aiApiKey) {
			new Notice("⚠️ 请先配置 API Key");
			return;
		}

		const folder = normalizePath(this.settings.inboxFolder);
		if (!(await this.app.vault.adapter.exists(folder))) {
			new Notice(`📂 文件夹「${this.settings.inboxFolder}」不存在\n💡 用 Obsidian 内置录音功能录一段试试`);
			return;
		}

		const list = await this.app.vault.adapter.list(folder);
		const files = list.files.filter(f => /\.(m4a|mp3|wav|ogg|webm|aac|flac)$/i.test(f));

		if (files.length === 0) {
			new Notice("📭 没有待处理的音频文件");
			return;
		}

		this.isBusy = true;
		const statusEl = this.addStatusBarItem();
		let ok = 0, fail = 0;

		for (let i = 0; i < files.length; i++) {
			const fp = files[i];
			const fn = fp.split("/").pop() || fp;
			statusEl.setText(`🎤 (${i + 1}/${files.length}) ${fn}`);

			try {
				const buf = await this.app.vault.adapter.readBinary(fp);
				const ext = fn.split(".").pop() || "webm";
				let mime = "audio/webm";
				if (ext === "m4a" || ext === "mp4") mime = "audio/mp4";
				else if (ext === "mp3") mime = "audio/mpeg";
				else if (ext === "wav") mime = "audio/wav";
				else if (ext === "ogg") mime = "audio/ogg";

				const blob = new Blob([buf], { type: mime });
				const txt = await this.callSTT(blob);
				if (!txt || txt.trim().length < 2) throw new Error("未识别到内容");

				const summary = await this.callAI(txt);
				await this.saveNote(fp, txt, summary);
				const todos = extractTodos(summary);
				if (todos.length > 0) await this.saveTodos(todos);
				ok++;
			} catch (e: any) {
				fail++;
				new Notice(`❌ ${fn}: ${e.message || e}`, 4000);
			}
		}

		statusEl.remove();
		this.isBusy = false;
		new Notice(ok > 0 ? `✅ ${ok} 成功` + (fail ? `, ${fail} 失败` : "") : `❌ 全部失败`);
	}

	// ===== API CALLS =====

	private async saveAudio(blob: Blob): Promise<string> {
		const dir = normalizePath(this.settings.inboxFolder);
		if (!(await this.app.vault.adapter.exists(dir))) await this.app.vault.createFolder(dir);
		const now = new Date();
		const fn = `录音-${fmtDate(now)}-${fmtTime(now)}.webm`;
		const fp = normalizePath(`${dir}/${fn}`);
		await this.app.vault.createBinary(fp, await blob.arrayBuffer());
		return fp;
	}

	private async callSTT(audioBlob: Blob): Promise<string> {
		// Convert to WAV if needed (SenseVoiceSmall works best with PCM WAV)
		let finalBlob = audioBlob;
		let finalExt = "webm";
		let finalMime = audioBlob.type || "audio/webm";

		if (!audioBlob.type.includes("wav") && !audioBlob.type.includes("mpeg")) {
			try {
				finalBlob = await this.convertToWav(audioBlob);
				finalExt = "wav";
				finalMime = "audio/wav";
			} catch (e) {
				console.warn("AudioInbox: WAV conversion failed, sending original format", e);
			}
		}

		// Manual multipart body (requestUrl compatible, works on mobile)
		const boundary = "----AiInbox" + Math.random().toString(36).slice(2);
		const enc = new TextEncoder();
		const buf = await finalBlob.arrayBuffer();
		const sizeKB = Math.round(buf.byteLength / 1024);

		const parts: Uint8Array[] = [];
		const line = (s: string) => parts.push(enc.encode(s));
		line(`--${boundary}\r\n`);
		line(`Content-Disposition: form-data; name="file"; filename="audio.${finalExt}"\r\n`);
		line(`Content-Type: ${finalMime}\r\n\r\n`);
		parts.push(new Uint8Array(buf));
		line(`\r\n--${boundary}\r\n`);
		line(`Content-Disposition: form-data; name="model"\r\n\r\n`);
		line(`${this.settings.sttModel}\r\n`);
		if (this.settings.sttLanguage) {
			line(`--${boundary}\r\n`);
			line(`Content-Disposition: form-data; name="language"\r\n\r\n`);
			line(`${this.settings.sttLanguage}\r\n`);
		}
		line(`--${boundary}\r\n`);
		line(`Content-Disposition: form-data; name="response_format"\r\n\r\n`);
		line(`text\r\n`);
		line(`--${boundary}--\r\n`);

		const total = parts.reduce((s, p) => s + p.length, 0);
		const body = new Uint8Array(total);
		let off = 0;
		for (const p of parts) { body.set(p, off); off += p.length; }

		console.log(`AudioInbox: Sending STT request (${sizeKB}KB, ${finalExt}), API: ${this.settings.sttApiUrl}`);

		const resp = await requestUrl({
			url: this.settings.sttApiUrl,
			method: "POST",
			headers: {
				"Authorization": `Bearer ${this.settings.sttApiKey}`,
				"Content-Type": `multipart/form-data; boundary=${boundary}`,
			},
			body: body.buffer,
		});

		console.log(`AudioInbox: STT response status=${resp.status}, contentType=${resp.headers?.["content-type"] || "?"}`);

		if (resp.status !== 200) {
			const errStr = (resp as any).text || JSON.stringify((resp as any).json || "");
			console.error("AudioInbox: STT error response:", errStr);
			if (errStr.includes("balance") || errStr.includes("30001") || errStr.includes("4032")) {
				throw new Error("STT 余额不足，请前往 siliconflow.cn 充值（10元即可）");
			}
			if (errStr.includes("invalid") || errStr.includes("Api key") || errStr.includes("401")) {
				throw new Error("STT API Key 无效，请检查设置");
			}
			if (errStr.includes("20015") || errStr.includes("format") || errStr.includes("decode")) {
				throw new Error("录音格式不兼容，请尝试更短的录音或更换格式");
			}
			throw new Error(`STT 失败 (${resp.status}): ${errStr.substring(0, 100)}`);
		}

		// response_format=text => API returns plain text
		const result = (resp as any).text || "";
		console.log(`AudioInbox: STT result length=${result.length}, preview="${result.substring(0, 80)}"`);
		return result;
	}

	private async convertToWav(blob: Blob): Promise<Blob> {
		const AudioCtx = (window as any).AudioContext || (window as any).webkitAudioContext;
		const ctx = new AudioCtx({ sampleRate: 16000 });
		if (ctx.state === "suspended") await ctx.resume();
		const audioBuf = await ctx.decodeAudioData(await blob.arrayBuffer());
		await ctx.close();

		// Encode as 16-bit PCM WAV (mono, 16000Hz)
		const numChannels = Math.min(audioBuf.numberOfChannels, 1);
		const sampleRate = audioBuf.sampleRate;
		const length = audioBuf.length;
		const channelData = audioBuf.getChannelData(0);

		const wavBuf = new ArrayBuffer(44 + length * 2);
		const view = new DataView(wavBuf);
		const writeStr = (off: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
		writeStr(0, "RIFF");
		view.setUint32(4, 36 + length * 2, true);
		writeStr(8, "WAVE");
		writeStr(12, "fmt ");
		view.setUint32(16, 16, true);
		view.setUint16(20, 1, true);
		view.setUint16(22, numChannels, true);
		view.setUint32(24, sampleRate, true);
		view.setUint32(28, sampleRate * numChannels * 2, true);
		view.setUint16(32, numChannels * 2, true);
		view.setUint16(34, 16, true);
		writeStr(36, "data");
		view.setUint32(40, length * 2, true);

		for (let i = 0; i < length; i++) {
			const sample = Math.max(-1, Math.min(1, channelData[i]));
			view.setInt16(44 + i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
		}

		return new Blob([wavBuf], { type: "audio/wav" });
	}

	private async callAI(text: string): Promise<string> {
		const resp = await requestUrl({
			url: this.settings.aiApiUrl,
			method: "POST",
			headers: { "Content-Type": "application/json", "Authorization": `Bearer ${this.settings.aiApiKey}` },
			body: JSON.stringify({
				model: this.settings.aiModel,
				messages: [
					{ role: "system", content: this.settings.summaryPrompt },
					{ role: "user", content: text },
				],
				temperature: 0.3, max_tokens: 2000,
			}),
		});
		if (resp.status !== 200) throw new Error(`AI (${resp.status})`);
		return resp.json?.choices?.[0]?.message?.content || "";
	}

	private async saveNote(audioPath: string, transcript: string, summary: string) {
		const dir = normalizePath(this.settings.outputFolder);
		if (!(await this.app.vault.adapter.exists(dir))) await this.app.vault.createFolder(dir);

		const now = new Date();
		const ds = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
		const ts = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
		const timeFile = `${pad(now.getHours())}-${pad(now.getMinutes())}`;

		let c = `# 🎤 语音笔记 — ${ds} ${ts}\n\n---\n\n${summary}\n\n---\n`;
		c += `> 📁 [[${audioPath}|录音文件]]\n> 🕐 ${ds} ${ts}\n\n`;
		if (this.settings.showTranscript) {
			c += `<details>\n<summary>📝 原始文本</summary>\n\n${transcript}\n\n</details>\n\n`;
		}
		c += `---\n*Audio Inbox 生成*\n`;

		// Each recording = separate file (not appended to daily)
		const np = normalizePath(`${dir}/语音笔记-${ds}-${timeFile}.md`);
		await this.app.vault.create(np, c);
	}

	private async saveTodos(todos: string[]) {
		const dir = normalizePath(this.settings.outputFolder);
		if (!(await this.app.vault.adapter.exists(dir))) await this.app.vault.createFolder(dir);

		const np = normalizePath(`${dir}/待办事项.md`);
		const now = new Date();
		const ds = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
		const ts = `${pad(now.getHours())}:${pad(now.getMinutes())}`;

		let entry = `\n## 🎤 ${ds} ${ts}\n`;
		for (const t of todos) {
			entry += `${t}\n`;
		}

		const ex = this.app.vault.getAbstractFileByPath(np);
		if (ex instanceof TFile) {
			await this.app.vault.modify(ex, (await this.app.vault.read(ex)) + entry);
		} else {
			await this.app.vault.create(np, `# ✅ 待办事项\n\n> 由 Audio Inbox 自动生成\n${entry}`);
		}

		// Also save clean file for iOS Shortcut: no prefix, one task per line
		const cp = normalizePath(`${dir}/待办-clean.txt`);
		const clean: string[] = [];
		for (const t of todos) {
			const s = t.replace(/^- \[ \] /, "").trim();
			if (s && s !== "无") clean.push(s);
		}
		if (clean.length > 0) {
			// Save to vault
			const cf = this.app.vault.getAbstractFileByPath(cp);
			const cleanContent = clean.join("\n");
			if (cf instanceof TFile) {
				const old = await this.app.vault.read(cf);
				await this.app.vault.modify(cf, old + "\n" + cleanContent);
			} else {
				await this.app.vault.create(cp, cleanContent);
			}

			// Also save to Shortcuts iCloud folder (for iOS Shortcut automation)
			this.saveToShortcutsFolder(cleanContent);
		}
	}

	/** Save clean todos to the Shortcuts iCloud container so the shortcut can read them */
	private saveToShortcutsFolder(content: string) {
		try {
			// Use Node.js built-in modules (available in Obsidian Electron)
			const fs = (window as any).require?.('fs') || require('fs');
			const path = (window as any).require?.('path') || require('path');
			const os = (window as any).require?.('os') || require('os');

			// Find iCloud Drive location
			let iCloudBase = '';
			const homeDir = os.homedir();

			if (process.platform === 'win32') {
				// Common iCloud Drive locations on Windows
				const candidates = [
					path.join(homeDir, 'iCloudDrive'),
					'F:\\iCloudDrive', 'D:\\iCloudDrive', 'E:\\iCloudDrive',
				];
				for (const c of candidates) {
					if (fs.existsSync(c)) { iCloudBase = c; break; }
				}
			} else {
				// macOS
				iCloudBase = path.join(homeDir, 'Library', 'Mobile Documents');
			}

			if (!iCloudBase || !fs.existsSync(iCloudBase)) {
				console.log('AudioInbox: iCloud Drive not found, skip Shortcuts sync');
				return;
			}

			const shortcutsDir = path.join(iCloudBase, 'iCloud~is~workflow~my~workflows');
			if (!fs.existsSync(shortcutsDir)) {
				fs.mkdirSync(shortcutsDir, { recursive: true });
			}

			const filePath = path.join(shortcutsDir, '待办-clean.txt');
			// Overwrite (not append) — each voice note's new todos replace the file
			fs.writeFileSync(filePath, content, 'utf-8');
			console.log('AudioInbox: Synced to Shortcuts folder:', filePath);
		} catch (e) {
			console.warn('AudioInbox: Could not sync to Shortcuts folder:', e);
		}
	}

	onunload() {
		if (this.fabEl) this.fabEl.remove();
	}
}

// ==================== UTILS ====================

function extractTodos(summary: string): string[] {
	const todos: string[] = [];
	const lines = summary.split("\n");
	let inSection = false;
	for (const line of lines) {
		if (/^##\s*✅?\s*待办/.test(line)) { inSection = true; continue; }
		if (inSection && /^##/.test(line)) break;
		if (inSection && /^\s*-\s*\[ \]\s*\S/.test(line)) {
			todos.push(line.trim());
		}
	}
	return todos;
}

// ==================== SETTINGS TAB ====================

class AudioInboxSettingTab extends PluginSettingTab {
	plugin: AudioInboxPlugin;
	constructor(app: App, plugin: AudioInboxPlugin) { super(app, plugin); this.plugin = plugin; }

	display() {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "🎤 Audio Inbox — 语音笔记" });

		// STT
		containerEl.createEl("h3", { text: "语音转文字 (STT) — 硅基流动" });
		containerEl.createEl("small", { text: "SiliconFlow SenseVoiceSmall 完全免费，需账户有余额（充10元够用很久）" });

		new Setting(containerEl).setName("STT API Key").addText(t => {
			t.setValue(this.plugin.settings.sttApiKey); t.inputEl.type = "password";
			t.onChange(async v => { this.plugin.settings.sttApiKey = v; await this.plugin.saveSettings(); });
		});
		new Setting(containerEl).setName("STT API 地址").addText(t =>
			t.setValue(this.plugin.settings.sttApiUrl).onChange(async v => { this.plugin.settings.sttApiUrl = v; await this.plugin.saveSettings(); }));
		new Setting(containerEl).setName("STT 模型").addText(t =>
			t.setValue(this.plugin.settings.sttModel).onChange(async v => { this.plugin.settings.sttModel = v; await this.plugin.saveSettings(); }));
		new Setting(containerEl).setName("语言 (zh/en)").addText(t =>
			t.setValue(this.plugin.settings.sttLanguage).onChange(async v => { this.plugin.settings.sttLanguage = v; await this.plugin.saveSettings(); }));

		// AI
		containerEl.createEl("h3", { text: "AI 总结 — DeepSeek" });
		new Setting(containerEl).setName("DeepSeek API Key").addText(t => {
			t.setValue(this.plugin.settings.aiApiKey); t.inputEl.type = "password";
			t.onChange(async v => { this.plugin.settings.aiApiKey = v; await this.plugin.saveSettings(); });
		});
		new Setting(containerEl).setName("API 地址").addText(t =>
			t.setValue(this.plugin.settings.aiApiUrl).onChange(async v => { this.plugin.settings.aiApiUrl = v; await this.plugin.saveSettings(); }));
		new Setting(containerEl).setName("模型").addText(t =>
			t.setValue(this.plugin.settings.aiModel).onChange(async v => { this.plugin.settings.aiModel = v; await this.plugin.saveSettings(); }));
		new Setting(containerEl).setName("总结指令").addTextArea(t => {
			t.setValue(this.plugin.settings.summaryPrompt); t.inputEl.rows = 6;
			t.onChange(async v => { this.plugin.settings.summaryPrompt = v; await this.plugin.saveSettings(); });
		});

		// Output
		containerEl.createEl("h3", { text: "输出" });
		new Setting(containerEl).setName("录音保存目录").addText(t =>
			t.setValue(this.plugin.settings.inboxFolder).onChange(async v => { this.plugin.settings.inboxFolder = v; await this.plugin.saveSettings(); }));
		new Setting(containerEl).setName("笔记输出目录").addText(t =>
			t.setValue(this.plugin.settings.outputFolder).onChange(async v => { this.plugin.settings.outputFolder = v; await this.plugin.saveSettings(); }));
		new Setting(containerEl).setName("显示原始文本").addToggle(t =>
			t.setValue(this.plugin.settings.showTranscript).onChange(async v => { this.plugin.settings.showTranscript = v; await this.plugin.saveSettings(); }));
	}
}

function pad(n: number) { return n.toString().padStart(2, "0"); }
function fmtDate(d: Date) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function fmtTime(d: Date) { return `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`; }
