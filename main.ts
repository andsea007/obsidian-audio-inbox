import { Plugin, Notice, PluginSettingTab, App, Setting, requestUrl, normalizePath, TFile, Modal, Platform } from "obsidian";

// ==================== TYPES ====================

type ContentType = "reminder" | "memo" | "mixed" | "unknown";

interface ParsedAI {
	type: ContentType;
	todos: string[];
	memo: string;
	summary: string;
}

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
	deleteAfterProcess: boolean;
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
	summaryPrompt: `分析以下录音文本，判断内容类型并生成结构化笔记。

## 判断类型
- 提醒事项：包含明确的任务、待办、时间约定、行动项（如"明天开会"、"买牛奶"、"提醒我..."）
- 备忘录：记录信息、想法、知识点、会议内容、无明确行动项（如"记住这个概念"、"今天学到了..."）
- 混合：既有备忘内容又有待办事项

## 输出格式（严格按此格式，不要添加额外说明）

### 类型
[提醒事项 / 备忘录 / 混合]

### 总结
用要点和编号列表组织关键信息，突出重点。简洁但完整。

### 待办事项
（仅当类型为"提醒事项"或"混合"时输出此节；每个一行，用 - [ ] 开头；无待办则写「- [ ] 无」）
- [ ] 示例待办

### 备忘内容
（仅当类型为"备忘录"或"混合"时输出此节；将原话整理成清晰条理的备忘正文，保留所有关键信息，去除口语化表达和冗余词句）`,
	showTranscript: false,
	deleteAfterProcess: true,
};

// ==================== RECORDING MODAL ====================

class RecordModal extends Modal {
	private resolve: (blob: Blob | null) => void;
	private stream: MediaStream | null = null;
	private mediaRecorder: MediaRecorder | null = null;
	private audioChunks: Blob[] = [];
	private startTime = 0;
	private timerId: number | null = null;
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
		statusRow.createSpan({ cls: "ai-dot" });
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
		} catch {
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
		this.mediaRecorder.ondataavailable = (e: BlobEvent) => { if (e.data.size > 0) this.audioChunks.push(e.data); };
		this.mediaRecorder.onstop = () => { this.finish(); };
		this.audioChunks = [];
		this.mediaRecorder.start(250);

		// Timer
		this.startTime = Date.now();
		this.timerId = window.setInterval(() => {
			const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
			const m = Math.floor(elapsed / 60).toString().padStart(2, "0");
			const s = (elapsed % 60).toString().padStart(2, "0");
			this.timerEl.setText(`${m}:${s}`);
		}, 200);

		stopBtn.onclick = () => { this.doStop(); };
	}

	private doStop() {
		if (this.timerId) window.clearInterval(this.timerId);
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
		if (this.timerId) window.clearInterval(this.timerId);
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
		this.addRibbonIcon("audio-lines", "语音笔记 — 开始录音", () => this.startRecordFlow());

		// Command — record
		this.addCommand({ id: "start-voice-record", name: "开始语音笔记（录音）", callback: () => this.startRecordFlow() });

		// Command — process inbox files
		this.addCommand({ id: "process-inbox", name: "处理录音文件夹", callback: () => this.processInbox() });

		// Command — mark exported todos as done
		this.addCommand({ id: "clear-exported-todos", name: "标记已同步的待办为完成", callback: () => this.markTodosDone() });

		// Settings
		this.addSettingTab(new AudioInboxSettingTab(this.app, this));

		// Floating button for mobile (big and hard to miss)
		this.addFab();
	}

	private addFab() {
		if (!Platform.isMobileApp) return;

		const fab = activeDocument.body.createDiv({ cls: "ai-fab" });
		fab.innerHTML = `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3" fill="#fff" stroke="none"/></svg>`;
		this.fabEl = fab;

		let dragging = false;
		let moved = false;
		let sx = 0, sy = 0, sl = 0, st = 0;

		// Only attach move/end to document DURING a drag
		const addListeners = () => {
			activeDocument.addEventListener("touchmove", onMove, { passive: false });
			activeDocument.addEventListener("touchend", onEnd);
			activeDocument.addEventListener("mousemove", onMove);
			activeDocument.addEventListener("mouseup", onEnd);
		};
		const removeListeners = () => {
			activeDocument.removeEventListener("touchmove", onMove);
			activeDocument.removeEventListener("touchend", onEnd);
			activeDocument.removeEventListener("mousemove", onMove);
			activeDocument.removeEventListener("mouseup", onEnd);
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
			fab.style.setProperty("left", `${sl + dx}px`);
			fab.style.setProperty("top", `${st + dy}px`);
			fab.addClass("ai-fab-dragged");
		};

		const onEnd = () => {
			removeListeners();
			window.setTimeout(() => { dragging = false; moved = false; }, 50);
		};

		fab.addEventListener("touchstart", onStart, { passive: false });
		fab.addEventListener("mousedown", onStart);

		fab.addEventListener("click", () => {
			if (dragging || moved) return;
			if (this.isBusy) { new Notice("⏳ 正在处理中..."); return; }
			void this.startRecordFlow();
		});

		// Re-inject if Obsidian mobile re-renders
		this.registerInterval(window.setInterval(() => {
			if (!activeDocument.body.contains(fab)) {
				activeDocument.body.appendChild(fab);
			}
		}, 3000));
	}

	async loadSettings() {
		const saved = await this.loadData() as Partial<AudioInboxSettings> | null;
		this.settings = Object.assign({}, DEFAULTS, saved || {});
		// Auto-migrate: if old prompt (without "### 类型" section) detected, replace with new one
		if (this.settings.summaryPrompt && !this.settings.summaryPrompt.includes("### 类型")) {
			this.settings.summaryPrompt = DEFAULTS.summaryPrompt;
			await this.saveSettings();
		}
		// Auto-migrate: if deleteAfterProcess not set (older settings), default to true
		if (saved && saved.deleteAfterProcess === undefined) {
			this.settings.deleteAfterProcess = true;
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
		const flowStartTime = Date.now();

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
				window.setTimeout(() => statusEl.remove(), 3000);
				new Notice(`⚠️ 未识别到语音\n📁 ${audioPath}\n💡 打开 Obsidian 开发者工具 (Ctrl+Shift+I) 查看 Console 日志，或检查 API Key 是否正确`);
				return;
			}

			// 4. AI summarize
			statusEl.setText("📝 AI 总结...");
			const summary = await this.callAI(transcript);
			console.log('AudioInbox: AI response:', summary.substring(0, 300));

			// 5. Parse AI response & save
			const parsed = parseAIResponse(summary);
			console.log(`AudioInbox: Parsed type=${parsed.type}, todos=${parsed.todos.length}, memoLen=${parsed.memo.length}`);
			await this.saveNote(audioPath, transcript, summary);

			if (parsed.type === "reminder" || parsed.type === "mixed") {
				if (parsed.todos.length > 0) {
					await this.saveTodos(parsed.todos);
				}
			}
			if (parsed.type === "memo" || parsed.type === "mixed") {
				if (parsed.memo) {
					await this.saveMemo(transcript, parsed.memo, audioPath);
				}
			}

			// 6. Delete audio file if enabled (save storage)
			if (this.settings.deleteAfterProcess) {
				try {
					const af = this.app.vault.getAbstractFileByPath(audioPath);
					if (af instanceof TFile) await this.app.vault.trash(af, true);
					console.log(`AudioInbox: Deleted audio ${audioPath}`);
				} catch (e) {
					console.warn('AudioInbox: Could not delete audio file:', e);
				}
			}

			statusEl.setText("✅ 完成");
			window.setTimeout(() => statusEl.remove(), 3000);
			const typeLabel = parsed.type === "memo" ? "💭 备忘录" : parsed.type === "reminder" ? "📌 提醒事项" : parsed.type === "mixed" ? "🔀 混合" : "📝 语音笔记";
			new Notice(`✅ ${typeLabel}已生成`);

		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			statusEl.setText("❌ 失败");
			window.setTimeout(() => statusEl.remove(), 5000);
			new Notice(`❌ ${msg}`, 8000);
			console.error(err);
		} finally {
			this.isBusy = false;
			console.log(`AudioInbox: Flow completed in ${Date.now() - flowStartTime}ms`);
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
				const parsed = parseAIResponse(summary);
				if ((parsed.type === "reminder" || parsed.type === "mixed") && parsed.todos.length > 0) {
					await this.saveTodos(parsed.todos);
				}
				if ((parsed.type === "memo" || parsed.type === "mixed") && parsed.memo) {
					await this.saveMemo(txt, parsed.memo, fp);
				}
				// Delete processed audio
				if (this.settings.deleteAfterProcess) {
					try {
						const af = this.app.vault.getAbstractFileByPath(fp);
						if (af instanceof TFile) await this.app.vault.trash(af, true);
					} catch (e) { console.warn('AudioInbox: Could not delete:', fp, e); }
				}
				ok++;
			} catch (e) {
				fail++;
				const msg = e instanceof Error ? e.message : String(e);
				new Notice(`❌ ${fn}: ${msg}`, 4000);
			}
		}

		statusEl.remove();
		this.isBusy = false;
		new Notice(ok > 0 ? `✅ ${ok} 成功` + (fail ? `, ${fail} 失败` : "") : `❌ 全部失败`);
	}

	// ===== API CALLS =====

	private async ensureFolder(dir: string): Promise<void> {
		if (!(await this.app.vault.adapter.exists(dir))) {
			await this.app.vault.createFolder(dir);
		}
	}

	private async saveAudio(blob: Blob): Promise<string> {
		const dir = normalizePath(this.settings.inboxFolder);
		await this.ensureFolder(dir);
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
			const errStr: string = resp.text || (resp.json ? JSON.stringify(resp.json) : "");
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
		const result: string = resp.text || "";
		console.log(`AudioInbox: STT result length=${result.length}, preview="${result.substring(0, 80)}"`);
		return result;
	}

	private async convertToWav(blob: Blob): Promise<Blob> {
		const win = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
		const AudioCtx = win.AudioContext || win.webkitAudioContext;
		if (!AudioCtx) throw new Error("AudioContext not supported");
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
		const json = resp.json as { choices?: Array<{ message?: { content?: string } }> };
		return json.choices?.[0]?.message?.content || "";
	}

	private async saveNote(audioPath: string, transcript: string, summary: string) {
		const dir = normalizePath(this.settings.outputFolder);
		await this.ensureFolder(dir);

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
		console.log(`AudioInbox: saveTodos called with ${todos.length} items:`, todos);

		const dir = normalizePath(this.settings.outputFolder);
		await this.ensureFolder(dir);

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
		// Each new recording OVERWRITES the file (not append) to prevent duplicates
		const cp = normalizePath(`${dir}/待办-clean.txt`);
		const clean: string[] = [];
		for (const t of todos) {
			const s = t.replace(/^- \[ \] /, "").trim();
			if (s && s !== "无") clean.push(s);
		}
		console.log(`AudioInbox: clean todos (${clean.length}):`, clean);

		if (clean.length > 0) {
			// Overwrite vault file (not append) — prevents duplicate reminders
			const cleanContent = clean.join("\n");
			const cf = this.app.vault.getAbstractFileByPath(cp);
			if (cf instanceof TFile) {
				await this.app.vault.modify(cf, cleanContent);
				console.log(`AudioInbox: Updated vault ${cp} (${cleanContent.length} chars)`);
			} else {
				await this.app.vault.create(cp, cleanContent);
				console.log(`AudioInbox: Created vault ${cp} (${cleanContent.length} chars)`);
			}

			// Also copy to clipboard for iOS Shortcuts sync
			this.saveToShortcutsFolder(cleanContent);
		} else {
			console.log('AudioInbox: No clean todos to save (all empty or "无")');
		}
	}

	/** Copy clean todos to clipboard for iOS Shortcuts sync.
	 *  The vault file (待办-clean.txt) is already saved by saveTodos(). */
	private saveToShortcutsFolder(content: string) {
		void navigator.clipboard.writeText(content).then(() => {
			console.log('AudioInbox: Copied todos to clipboard');
			new Notice(`✅ 待办已同步\n📋 已复制到剪贴板`);
		}).catch((e: unknown) => {
			console.warn('AudioInbox: Clipboard write failed:', e);
			new Notice(`⚠️ 剪贴板写入失败，但待办已保存到\n${this.settings.outputFolder}/待办-clean.txt`, 6000);
		});
	}

	/** Save a memo entry to 备忘录.md — includes both AI summary and original transcript.
	 *  Uses Obsidian vault API only (works on desktop & mobile, no Node.js fs). */
	private async saveMemo(transcript: string, memoContent: string, audioPath: string) {
		console.log(`AudioInbox: saveMemo called, memo length=${memoContent.length}, transcript length=${transcript.length}`);

		const dir = normalizePath(this.settings.outputFolder);
		await this.ensureFolder(dir);

		const np = normalizePath(`${dir}/备忘录.md`);
		const now = new Date();
		const ds = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
		const ts = `${pad(now.getHours())}:${pad(now.getMinutes())}`;

		let entry = `\n---\n\n## 💭 ${ds} ${ts}\n\n`;
		entry += `### 📝 AI 总结\n\n${memoContent}\n\n`;
		entry += `### 🗣️ 原话\n\n> ${transcript.replace(/\n/g, "\n> ")}\n`;

		try {
			const ex = this.app.vault.getAbstractFileByPath(np);
			if (ex instanceof TFile) {
				const oldContent = await this.app.vault.read(ex);
				await this.app.vault.modify(ex, oldContent + entry);
				console.log(`AudioInbox: Appended memo to ${np}`);
			} else {
				await this.app.vault.create(np, `# 💭 备忘录\n\n> 由 Audio Inbox 自动生成${entry}`);
				console.log(`AudioInbox: Created ${np}`);
			}
		} catch (err) {
			console.error(`AudioInbox: saveMemo failed for ${np}`, err);
			new Notice(`⚠️ 备忘录保存失败，请检查 ${dir} 目录权限`, 5000);
		}
	}

	/** Mark all `- [ ]` in 待办事项.md as `- [x]` and clear 待办-clean.txt */
	private async markTodosDone() {
		const dir = normalizePath(this.settings.outputFolder);
		const todoPath = normalizePath(`${dir}/待办事项.md`);
		const cleanPath = normalizePath(`${dir}/待办-clean.txt`);

		// 1. Replace all unchecked todos with checked in 待办事项.md
		const todoFile = this.app.vault.getAbstractFileByPath(todoPath);
		if (todoFile instanceof TFile) {
			const content = await this.app.vault.read(todoFile);
			const updated = content.replace(/^- \[ \] /gm, "- [x] ");
			if (updated !== content) {
				await this.app.vault.modify(todoFile, updated);
			}
		}

		// 2. Clear 待办-clean.txt
		const cleanFile = this.app.vault.getAbstractFileByPath(cleanPath);
		if (cleanFile instanceof TFile) {
			await this.app.vault.modify(cleanFile, "");
		}

		new Notice("✅ 已同步的待办已标记为完成，待办文件已清空");
	}

	onunload() {
		if (this.fabEl) this.fabEl.remove();
	}
}

// ==================== UTILS ====================

/** Parse the AI response to extract content type, todos, memo, and summary.
 *  Handles both the new structured format (### 类型) and the legacy format (## 📋 总结 / ## ✅ 待办事项). */
function parseAIResponse(text: string): ParsedAI {
	const lines = text.split("\n");
	let type: ContentType = "unknown";
	const todos: string[] = [];
	let memo = "";
	let summary = "";

	let currentSection: "type" | "summary" | "todos" | "memo" | null = null;

	for (const line of lines) {
		const trimmed = line.trim();

		// Detect section headers — accept both ### and ##, with or without emoji
		// New format: ### 类型 / ### 总结 / ### 待办事项 / ### 备忘内容
		// Old format: ## 📋 总结 / ## ✅ 待办事项
		if (/^#{2,3}\s*类型/i.test(trimmed)) {
			currentSection = "type";
			continue;
		}
		if (/^#{2,3}\s*📋?\s*总结/i.test(trimmed)) {
			currentSection = "summary";
			continue;
		}
		if (/^#{2,3}\s*✅?\s*待办/i.test(trimmed)) {
			currentSection = "todos";
			continue;
		}
		if (/^#{2,3}\s*💭?\s*备忘/i.test(trimmed)) {
			currentSection = "memo";
			continue;
		}

		// Extract content based on current section
		if (currentSection === "type" && trimmed) {
			if (trimmed.includes("提醒")) type = "reminder";
			else if (trimmed.includes("备忘")) type = "memo";
			else if (trimmed.includes("混合")) type = "mixed";
		} else if (currentSection === "summary" && trimmed) {
			summary += line + "\n";
		} else if (currentSection === "todos") {
			if (/^\s*-\s*\[ \]\s*\S/.test(line)) {
				todos.push(line.trim());
			}
		} else if (currentSection === "memo" && trimmed) {
			memo += line + "\n";
		}
	}

	// Fallback inference when AI didn't output a ### 类型 section
	if (type === "unknown") {
		const hasTodos = todos.length > 0;
		const hasMemo = memo.trim().length > 0;
		if (hasTodos && hasMemo) type = "mixed";
		else if (hasTodos) type = "reminder";
		else if (hasMemo) type = "memo";
		// If neither, check the summary for action-oriented keywords
		else if (summary) {
			// If summary mentions tasks/todos keywords, treat as reminder
			if (/待办|任务|提醒|记得|要去|要买|要完成|开会|提交/.test(summary)) {
				type = "reminder";
			} else {
				type = "memo";
				memo = summary; // use summary as memo content
			}
		}
	}

	// If type is memo/mixed but memo is empty, use summary as memo content
	if ((type === "memo" || type === "mixed") && !memo.trim() && summary.trim()) {
		memo = summary;
	}

	return { type, todos, memo: memo.trim(), summary: summary.trim() };
}

// ==================== SETTINGS TAB ====================

class AudioInboxSettingTab extends PluginSettingTab {
	plugin: AudioInboxPlugin;
	constructor(app: App, plugin: AudioInboxPlugin) { super(app, plugin); this.plugin = plugin; }

	display() {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName("🎤 语音笔记设置").setHeading();

		// STT
		new Setting(containerEl).setName("语音转文字 (STT) — 硅基流动").setDesc("SiliconFlow SenseVoiceSmall 完全免费，需账户有余额（充10元够用很久）").setHeading();

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
		new Setting(containerEl).setName("AI 总结 — DeepSeek").setHeading();
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
		new Setting(containerEl).setName("输出").setHeading();
		new Setting(containerEl).setName("录音保存目录").addText(t =>
			t.setValue(this.plugin.settings.inboxFolder).onChange(async v => { this.plugin.settings.inboxFolder = v; await this.plugin.saveSettings(); }));
		new Setting(containerEl).setName("笔记输出目录").addText(t =>
			t.setValue(this.plugin.settings.outputFolder).onChange(async v => { this.plugin.settings.outputFolder = v; await this.plugin.saveSettings(); }));
		new Setting(containerEl).setName("显示原始文本").addToggle(t =>
			t.setValue(this.plugin.settings.showTranscript).onChange(async v => { this.plugin.settings.showTranscript = v; await this.plugin.saveSettings(); }));
		new Setting(containerEl).setName("处理后删除录音文件").setDesc("开启后录音转文字完成后自动删除原音频，节省空间。关闭则保留录音文件。").addToggle(t =>
			t.setValue(this.plugin.settings.deleteAfterProcess).onChange(async v => { this.plugin.settings.deleteAfterProcess = v; await this.plugin.saveSettings(); }));
	}
}

function pad(n: number) { return n.toString().padStart(2, "0"); }
function fmtDate(d: Date) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function fmtTime(d: Date) { return `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`; }
