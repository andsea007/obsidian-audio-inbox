import { Plugin, Notice, PluginSettingTab, App, Setting, requestUrl, normalizePath, TFile, Modal, Platform } from "obsidian";

// ==================== TYPES ====================

type ContentType = "reminder" | "memo" | "mixed" | "unknown";

interface ParsedAI {
	type: ContentType;
	todos: string[];
	memo: string;
	summary: string;
	title: string;
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
	summaryPrompt: `你是一名智能语音笔记助手。以下文本由语音识别（STT）自动生成，**可能包含错别字、同音字、漏字、断句错误**。

## 核心规则（必须先执行）
1. **语义修正**：对于明显不通顺、不合逻辑的词汇/短语，根据上下文推断正确含义并修正。例如：
   - "1元线行，为何方长了秋季" → 推断为 "一元线性回归" 
   - "星入骨鱼竿" → 可能是 "星露谷物语里的鱼竿"
   - 同音字错误必须修正
2. **补全残缺**：如果句子明显断裂或不完整，根据前后文补全合理内容
3. **去噪**：忽略语气词、口头禅、重复的废话
4. **保留关键信息**：即使不确定某些词的准确形态，也要保留可能的含义，宁可保留不删

## 判断内容类型
- 提醒事项：包含任务、待办、时间约定、行动项
- 备忘录：信息、想法、知识点、会议内容，无明确行动项
- 混合：既有备忘又有待办

## 输出格式（严格按此格式，不要额外说明）

### 标题
用一句话概括核心内容，不超过10个字。例如"一元线性回归"、"明天下午开会"、"星露谷物语鱼竿"

### 类型
[提醒事项 / 备忘录 / 混合]

### 总结
用要点和编号列表组织关键信息，突出核心，简洁完整。

### 待办事项
（提醒/混合时输出；每个一行，- [ ] 开头；无待办写「- [ ] 无」）
- [ ] 示例

### 备忘内容
（备忘/混合时输出；整理成清晰备忘正文，修正所有识别错误，保留全部关键信息）`,
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
		const svgns = "http://www.w3.org/2000/svg";
		const svg = document.createElementNS(svgns, "svg");
		svg.setAttribute("width", "40"); svg.setAttribute("height", "40");
		svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("fill", "none");
		svg.setAttribute("stroke", "#fff"); svg.setAttribute("stroke-width", "1.5");
		svg.setAttribute("stroke-linecap", "round");
		[4, 7, 10].forEach((r, i) => {
			const c = document.createElementNS(svgns, "circle");
			c.setAttribute("cx", "12"); c.setAttribute("cy", "12");
			c.setAttribute("r", String(r));
			c.setAttribute("opacity", String([0.55, 0.35, 0.18][i]));
			svg.appendChild(c);
		});
		const dot = document.createElementNS(svgns, "circle");
		dot.setAttribute("cx", "12"); dot.setAttribute("cy", "12");
		dot.setAttribute("r", "3"); dot.setAttribute("fill", "#fff");
		dot.setAttribute("stroke", "none"); svg.appendChild(dot);
		fab.appendChild(svg);
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
		// Auto-migrate: if old prompt (without key new-format sections) detected, force replace
		if (this.settings.summaryPrompt && (!this.settings.summaryPrompt.includes("### 备忘内容") || !this.settings.summaryPrompt.includes("### 类型"))) {
			this.settings.summaryPrompt = DEFAULTS.summaryPrompt;
			await this.saveSettings();
			console.log('AudioInbox: Migrated summaryPrompt to new format');
		}
		// Auto-migrate: if deleteAfterProcess not set, default to true
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

			// 5. Parse AI response — save to memo/todo only
			const parsed = parseAIResponse(summary);

			if (parsed.type === "reminder" || parsed.type === "mixed") {
				if (parsed.todos.length > 0) {
					await this.saveTodos(parsed.todos, parsed.title);
				}
			}
			if (parsed.type === "memo" || parsed.type === "mixed") {
				if (parsed.memo) {
					await this.saveMemo(transcript, parsed.memo, audioPath, parsed.title);
				}
			}

			// 6. Delete audio file if enabled (save storage)
			if (this.settings.deleteAfterProcess) {
				try {
					const af = this.app.vault.getAbstractFileByPath(audioPath);
					if (af instanceof TFile) await this.app.fileManager.trashFile(af);
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
				const parsed = parseAIResponse(summary);
				if ((parsed.type === "reminder" || parsed.type === "mixed") && parsed.todos.length > 0) {
					await this.saveTodos(parsed.todos, parsed.title);
				}
				if ((parsed.type === "memo" || parsed.type === "mixed") && parsed.memo) {
					await this.saveMemo(txt, parsed.memo, fp, parsed.title);
				}
				// Delete processed audio
				if (this.settings.deleteAfterProcess) {
					try {
						const af = this.app.vault.getAbstractFileByPath(fp);
						if (af instanceof TFile) await this.app.fileManager.trashFile(af);
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
		// Split path and create each level to work around mobile recursive folder issues
		const parts = dir.split("/").filter(p => p.length > 0);
		let current = "";
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (!(await this.app.vault.adapter.exists(current))) {
				await this.app.vault.createFolder(current);
			}
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
				temperature: 0.3, max_tokens: 3000,
			}),
		});
		if (resp.status !== 200) throw new Error(`AI (${resp.status})`);
		const json = resp.json as { choices?: Array<{ message?: { content?: string } }> };
		return json.choices?.[0]?.message?.content || "";
	}

	// ===== SAVE: 四级目录 — VoiceNotes/月/日/单文件 =====

	/** Save a single memo as an independent file under VoiceNotes/YYYY-MM/YYYY-MM-DD/ */
	private async saveMemo(transcript: string, memoContent: string, audioPath: string, title: string) {
		const { dir, ds, ts, timeSlug } = this.datePath();
		await this.ensureFolder(dir);
		const safeTitle = title ? title.replace(/[\\/:*?"<>|]/g, "").trim() : "";

		let fn = safeTitle ? `${safeTitle}.md` : `备忘.md`;
		let np = normalizePath(`${dir}/${fn}`);

		const content = [
			`# 💭 ${safeTitle || '备忘'}`,
			``,
			`> 🕐 ${ds} ${ts}`,
			``,
			`---`,
			``,
			`### 📝 AI 总结`,
			``,
			memoContent,
			``,
			`### 🗣️ 原话`,
			``,
			`> ${transcript.replace(/\n/g, "\n> ")}`,
			``,
		].join("\n");

		try {
			const adapter = this.app.vault.adapter;
			if (await adapter.exists(np)) {
				fn = safeTitle ? `${safeTitle}-${timeSlug}.md` : `备忘-${timeSlug}.md`;
				np = normalizePath(`${dir}/${fn}`);
			}
			await adapter.write(np, content);
			console.log(`AudioInbox: saved memo → ${np}`);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			console.error('AudioInbox: saveMemo error', e);
			new Notice(`❌ 备忘录保存失败: ${msg}`, 8000);
		}
	}

	/** Save todo items as a single file under VoiceNotes/YYYY-MM/YYYY-MM-DD/ */
	private async saveTodos(todos: string[], title: string) {
		console.log(`AudioInbox: saveTodos called with ${todos.length} items:`, todos);

		const { dir, ds, ts, timeSlug } = this.datePath();
		await this.ensureFolder(dir);
		const safeTitle = title ? title.replace(/[\\/:*?"<>|]/g, "").trim() : "";

		let fn = safeTitle ? `待办-${safeTitle}.md` : `待办.md`;
		let np = normalizePath(`${dir}/${fn}`);

		const content = [
			`# 📌 ${safeTitle || '待办事项'}`,
			``,
			`> 🕐 ${ds} ${ts}`,
			``,
			`---`,
			``,
			todos.join("\n"),
			``,
		].join("\n");

		try {
			const adapter = this.app.vault.adapter;
			if (await adapter.exists(np)) {
				fn = safeTitle ? `待办-${safeTitle}-${timeSlug}.md` : `待办-${timeSlug}.md`;
				np = normalizePath(`${dir}/${fn}`);
			}
			await adapter.write(np, content);
			console.log(`AudioInbox: saved todo → ${np}`);
		} catch (e) {
			console.error('AudioInbox: saveTodos error', e);
		}

		// Sync to clean.txt (append + dedup) and clipboard for iOS Shortcuts
		const clean: string[] = [];
		for (const t of todos) {
			const s = t.replace(/^- \[ \] /, "").trim();
			if (s && s !== "无") clean.push(s);
		}
		if (clean.length > 0) {
			this.syncCleanTodos(clean);
		}
	}

	/** Compute the date-based folder path: VoiceNotes/YYYY-MM/YYYY-MM-DD */
	private datePath() {
		const now = new Date();
		const y = now.getFullYear();
		const mo = pad(now.getMonth() + 1);
		const d = pad(now.getDate());
		const hh = pad(now.getHours());
		const mm = pad(now.getMinutes());
		const ds = `${y}-${mo}-${d}`;
		const ts = `${hh}:${mm}`;
		const timeSlug = `${hh}${mm}`;
		const dir = normalizePath(`${this.settings.outputFolder}/${y}-${mo}/${ds}`);
		return { dir, ds, ts, timeSlug };
	}

	/** Maintain VoiceNotes/待办-clean.txt — append new tasks, dedup */
	private async syncCleanTodos(tasks: string[]) {
		const cp = normalizePath(`${this.settings.outputFolder}/待办-clean.txt`);
		try {
			const adapter = this.app.vault.adapter;
			const existing = new Set<string>();
			if (await adapter.exists(cp)) {
				const old = await adapter.read(cp);
				old.split("\n").forEach(l => { const t2 = l.trim(); if (t2) existing.add(t2); });
			}
			const newTasks = tasks.filter(t => !existing.has(t));
			if (newTasks.length > 0) {
				await adapter.write(cp, [...existing, ...newTasks].join("\n"));
				console.log(`AudioInbox: clean.txt +${newTasks.length} tasks`);
			}
			void navigator.clipboard.writeText([...existing, ...newTasks].join("\n"));
		} catch (e) {
			console.warn('AudioInbox: syncCleanTodos error', e);
		}
	}

	/** Recursively mark all pending todos as done and clear clean.txt */
	private async markTodosDone() {
		const baseDir = normalizePath(this.settings.outputFolder);
		const cleanPath = normalizePath(`${baseDir}/待办-clean.txt`);
		let marked = 0;

		// Walk month → date folders scanning for 待办-*.md files
		try {
			const adapter = this.app.vault.adapter;
			if (!(await adapter.exists(baseDir))) return;

			const monthList = await adapter.list(baseDir);
			for (const monthItem of monthList.folders) {
				const dateList = await adapter.list(monthItem);
				for (const dateItem of dateList.folders) {
					const fileList = await adapter.list(dateItem);
					for (const fp of fileList.files) {
						const fn = fp.split("/").pop() || "";
						if (!fn.startsWith("待办-") || !fn.endsWith(".md")) continue;
						const f = this.app.vault.getAbstractFileByPath(fp);
						if (f instanceof TFile) {
							const old = await this.app.vault.read(f);
							const updated = old.replace(/^- \[ \] /gm, "- [x] ");
							if (updated !== old) {
								await this.app.vault.modify(f, updated);
								marked++;
							}
						}
					}
				}
			}
		} catch (e) {
			console.error('AudioInbox: markTodosDone scan error', e);
		}

		// Clear clean.txt
		const cf = this.app.vault.getAbstractFileByPath(cleanPath);
		if (cf instanceof TFile) {
			await this.app.vault.modify(cf, "");
		}

		new Notice(`✅ 已标记 ${marked} 个待办文件为完成`);
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
	let title = "";

	let currentSection: "type" | "title" | "summary" | "todos" | "memo" | null = null;

	for (const line of lines) {
		const trimmed = line.trim();

		// Detect section headers — accept both ### and ##
		// IMPORTANT: no emoji in regex patterns (causes match failures in some JS engines)
		if (/^#{2,3}\s*标题/i.test(trimmed)) {
			currentSection = "title";
			// Also extract title if it's on the same line (e.g., "### 标题：一元线性回归")
			const inlineAfter = trimmed.replace(/^#{2,3}\s*标题[:：\s]*/i, "").trim();
			if (inlineAfter && !title) title = inlineAfter.substring(0, 10);
			continue;
		}
		if (/^#{2,3}\s*类型/i.test(trimmed)) {
			currentSection = "type";
			continue;
		}
		if (/^#{2,3}\s*总结/i.test(trimmed)) {
			currentSection = "summary";
			continue;
		}
		if (/^#{2,3}\s*待办/i.test(trimmed)) {
			currentSection = "todos";
			continue;
		}
		if (/^#{2,3}\s*备忘/i.test(trimmed)) {
			currentSection = "memo";
			continue;
		}

		// Extract content based on current section
		if (currentSection === "title" && trimmed && !title) {
			title = trimmed.substring(0, 10);
		} else if (currentSection === "type" && trimmed) {
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
		const hasRealTodos = todos.some(t => !t.includes("无"));
		const hasMemo = memo.trim().length > 0;
		const hasSummary = summary.trim().length > 0;
		if (hasMemo && hasRealTodos) type = "mixed";
		else if (hasMemo) type = "memo";
		else if (hasRealTodos) type = "reminder";
		// If only "无" todos or no todos at all, but has summary → likely a memo
		else if (hasSummary) {
			if (/待办|任务|提醒|记得要去|要买|要完成|开会|提交|约定|^{{1,2}\d/.test(summary)) {
				type = "reminder";
			} else {
				type = "memo";
				memo = summary;
			}
		}
	}

	// If type is memo/mixed but memo is empty, use summary as memo content
	if ((type === "memo" || type === "mixed") && !memo.trim() && summary.trim()) {
		memo = summary;
	}

	return { type, todos, memo: memo.trim(), summary: summary.trim(), title };
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

function pad(n: number): string { return n.toString().padStart(2, "0"); }
function fmtDate(d: Date) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function fmtTime(d: Date) { return `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`; }
