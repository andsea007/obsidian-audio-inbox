import { Plugin, Notice, PluginSettingTab, App, Setting, requestUrl, normalizePath, TFile, Modal, Platform, TextAreaComponent, DropdownComponent, ButtonComponent, RequestUrlResponse } from "obsidian";

// ==================== TYPES ====================

type ContentType = "reminder" | "memo" | "mixed" | "unknown";
type STTProvider = "compatible" | "doubao";
type DoubaoAuthMode = "api-key" | "app-token";
type DoubaoMode = "standard" | "flash";

const DOUBAO_STT_URL = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash";
const DOUBAO_RESOURCE_ID = "volc.bigasr.auc_turbo";
const DOUBAO_STANDARD_URL = "https://openspeech.bytedance.com/api/v3/auc/bigmodel";
const DOUBAO_MAX_AUDIO_BYTES = 100 * 1024 * 1024;

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
	sttProvider: STTProvider;
	sttApiUrl: string;
	sttApiKey: string;
	sttModel: string;
	sttLanguage: string;
	doubaoAuthMode: DoubaoAuthMode;
	doubaoMode: DoubaoMode;
	doubaoApiKey: string;
	doubaoAppId: string;
	doubaoAccessToken: string;
	aiApiUrl: string;
	aiApiKey: string;
	aiModel: string;
	summaryPrompt: string;
	maxRecordMinutes: number;
	autoStopOnLimit: boolean;
	showFloatingButton: boolean;
	promptHistory: string[];
	promptVersion?: number;
	showTranscript: boolean;
	deleteAfterProcess: boolean;
}

const DEFAULTS: AudioInboxSettings = {
	inboxFolder: "录音",
	outputFolder: "VoiceNotes",
	sttProvider: "compatible",
	sttApiUrl: "https://api.siliconflow.cn/v1/audio/transcriptions",
	sttApiKey: "",
	sttModel: "TeleAI/TeleSpeechASR",
	sttLanguage: "zh",
	doubaoAuthMode: "api-key",
	doubaoMode: "standard",
	doubaoApiKey: "",
	doubaoAppId: "",
	doubaoAccessToken: "",
	aiApiUrl: "https://api.deepseek.com/v1/chat/completions",
	aiApiKey: "",
	aiModel: "deepseek-v4-flash",
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
提取一个简洁主题词（≤10字）。必须是内容的语义概括，**禁止**包含任何日期、时间、星期、数字编号、钟点。
正确示例："一元线性回归"、"明天开会讨论"、"星露谷鱼竿"
错误示例："2026-07-11"、"下午三点"、"18:30"、"周三"

### 类型
[提醒事项 / 备忘录 / 混合]

### 总结
用要点和编号列表组织关键信息，突出核心，简洁完整。

### 待办事项
（提醒/混合时输出；每个一行，- [ ] 开头；无待办写「- [ ] 无」）
- [ ] 示例

### 备忘内容
（备忘/混合时输出；整理成清晰备忘正文，修正所有识别错误，保留全部关键信息）`,
	maxRecordMinutes: 60,
	autoStopOnLimit: true,
	showFloatingButton: true,
	promptHistory: [],
	showTranscript: false,
	deleteAfterProcess: false,
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
	private stopRequested = false;
	private interrupted = false;
	private mimeType = "";
	private timerEl!: HTMLSpanElement;
	private warnEl!: HTMLDivElement;
	private maxDurationSec: number;
	private autoStop: boolean;
	private warnAtSec = 30;
	private autoStopped = false;
	private wakeLock: { release: () => Promise<void> } | null = null;
	private readonly onVisibilityChange = () => {
		if (activeDocument.hidden) {
			const lock = this.wakeLock;
			this.wakeLock = null;
			if (lock) void lock.release();
			return;
		}
		if (!this.isFinished) void this.acquireWakeLock();
	};

	constructor(app: App, resolve: (blob: Blob | null) => void, maxDurationSec = 0, autoStop = true) {
		super(app);
		this.resolve = resolve;
		this.maxDurationSec = maxDurationSec;
		this.autoStop = autoStop;
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
		const maxLabel = this.maxDurationSec > 0 ? `（最长 ${this.formatDuration(this.maxDurationSec)}）` : "（不限时长）";
		statusRow.createSpan({ text: ` 录音中，请说话...${maxLabel}`, cls: "ai-modal-label" });
		this.warnEl = contentEl.createDiv({ cls: "ai-modal-warn" });
		this.warnAtSec = this.maxDurationSec >= 3600 ? 60 : 30;
		if (this.maxDurationSec > 0) {
			this.warnEl.setText(`💡 默认上限 ${this.formatDuration(this.maxDurationSec)}；请保持 Obsidian 在前台，手机锁屏可能中断录音`);
		}

		// Buttons
		const btns = contentEl.createDiv({ cls: "ai-modal-btns" });
		const stopBtn = btns.createEl("button", { text: "⏹ 停止录音", cls: "ai-modal-stop" });

		// Get mic
		try {
			this.stream = await navigator.mediaDevices.getUserMedia({
				audio: { echoCancellation: true, noiseSuppression: true },
			});
			if (this.isFinished) {
				this.stream.getTracks().forEach(t => t.stop());
				return;
			}
		} catch {
			contentEl.empty();
			contentEl.createEl("h3", { text: "❌ 无法访问麦克风" });
			contentEl.createEl("p", { text: "请在系统设置中允许 Obsidian 使用麦克风权限，然后重试。" });
			contentEl.createEl("p", { text: "💡 或者用 Obsidian 内置录音功能录制，保存到「录音」文件夹，再用 Ctrl+P「处理录音文件夹」功能。" });
			const closeBtn = contentEl.createEl("button", { text: "关闭", cls: "ai-modal-stop" });
			closeBtn.onclick = () => { this.close(); };
			return;
		}

		// Keep the compressed recording intact. WebM/Opus at 64 kbps is about 29 MB/hour.
		try {
			const supportedMime = [
				"audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus", "audio/webm", "audio/ogg",
			].find(type => MediaRecorder.isTypeSupported(type));
			this.mimeType = supportedMime || "";
			this.mediaRecorder = this.mimeType
				? new MediaRecorder(this.stream, { mimeType: this.mimeType, audioBitsPerSecond: 64000 })
				: new MediaRecorder(this.stream, { audioBitsPerSecond: 64000 });
			this.mediaRecorder.ondataavailable = (e: BlobEvent) => { if (e.data.size > 0) this.audioChunks.push(e.data); };
			this.mediaRecorder.onstop = () => {
				if (!this.stopRequested && !this.autoStopped) this.interrupted = true;
				this.finish();
			};
			this.audioChunks = [];
			// Emit one finalized container when recording stops.
			this.mediaRecorder.start();
		} catch (error) {
			console.error("AudioInbox: Could not start recorder", error);
			new Notice("录音器启动失败，请检查设备的音频录制支持情况");
			this.mediaRecorder = null;
			this.finish();
			return;
		}
		activeDocument.addEventListener("visibilitychange", this.onVisibilityChange);
		void this.acquireWakeLock();

		// Timer
		this.startTime = Date.now();
		this.timerId = window.setInterval(() => {
			const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
			const elapsedMin: number = Math.floor(elapsed / 60);
			const elapsedSec: number = elapsed % 60;
			const m: string = (elapsedMin < 10 ? "0" : "") + String(elapsedMin);
			const s: string = (elapsedSec < 10 ? "0" : "") + String(elapsedSec);
			this.timerEl.setText(`${m}:${s}`);

			if (this.maxDurationSec > 0 && !this.isFinished && !this.autoStopped) {
				const remaining = this.maxDurationSec - elapsed;
				if (elapsed >= this.maxDurationSec) {
					if (this.autoStop) {
						this.autoStopped = true;
						this.timerEl.removeClass("ai-modal-timer-warn");
						this.timerEl.addClass("ai-modal-timer-limit");
						this.warnEl.setText("⏰ 已达最长录音时长，自动结束录音");
						this.doStop();
					} else {
						this.timerEl.addClass("ai-modal-timer-limit");
						this.warnEl.setText("⚠️ 已超过建议录音时长，请尽快手动停止");
						this.warnEl.addClass("ai-modal-warn-active");
					}
				} else if (remaining <= this.warnAtSec) {
					this.warnEl.setText(this.autoStop
						? `⚠️ ${remaining} 秒后自动结束录音`
						: `⚠️ ${remaining} 秒后到达建议时长，请准备结束`);
					this.warnEl.addClass("ai-modal-warn-active");
					this.timerEl.addClass("ai-modal-timer-warn");
				} else {
					this.warnEl.setText(this.maxDurationSec > 0
						? `💡 默认上限 ${this.formatDuration(this.maxDurationSec)}；请保持 Obsidian 在前台，手机锁屏可能中断录音`
						: "");
					this.warnEl.removeClass("ai-modal-warn-active");
					this.timerEl.removeClass("ai-modal-timer-warn");
				}
			}
		}, 200);

		stopBtn.onclick = () => { this.doStop(); };
	}

	private doStop() {
		if (this.timerId) { window.clearInterval(this.timerId); this.timerId = null; }
		if (this.mediaRecorder) {
			if (this.mediaRecorder.state !== "inactive") {
				this.stopRequested = true;
				this.mediaRecorder.stop();
			}
			// An inactive recorder can still have a queued final dataavailable event.
			// Its onstop handler calls finish() after that event arrives.
		} else {
			this.finish();
		}
	}

	private async acquireWakeLock() {
		if (this.wakeLock || this.isFinished) return;
		try {
			const nav = navigator as Navigator & { wakeLock?: { request: (type: "screen") => Promise<{ release: () => Promise<void> }> } };
			const lock = await nav.wakeLock?.request("screen");
			if (this.isFinished) { if (lock) void lock.release(); return; }
			this.wakeLock = lock || null;
		} catch {
			// Screen Wake Lock is optional; unsupported devices can still record while foregrounded.
		}
	}

	private finish() {
		if (this.isFinished) return;
		this.isFinished = true;
		activeDocument.removeEventListener("visibilitychange", this.onVisibilityChange);
		if (this.wakeLock) { void this.wakeLock.release(); this.wakeLock = null; }
		if (this.stream) this.stream.getTracks().forEach(t => t.stop());
		if (this.timerId) window.clearInterval(this.timerId);
		const blob = this.audioChunks.length > 0
			? new Blob(this.audioChunks, { type: this.mediaRecorder?.mimeType || this.mimeType || "audio/webm" })
			: null;
		if (blob && this.interrupted) (blob as Blob & { audioInboxInterrupted?: boolean }).audioInboxInterrupted = true;
		this.resolve(blob);
		if (this.autoStopped) new Notice("⏰ 已达最长录音时长，已自动结束录音");
		this.close();
	}

	private formatDuration(sec: number): string {
		const m: number = Math.floor(sec / 60);
		const s: number = sec % 60;
		return `${pad(m)}:${pad(s)}`;
	}

	onClose() {
		// Wait for MediaRecorder's final dataavailable event before resolving.
		if (!this.isFinished) this.doStop();
	}
}

// ==================== MAIN PLUGIN ====================

export default class AudioInboxPlugin extends Plugin {
	settings: AudioInboxSettings;
	private isBusy = false;
	private fabEl: HTMLElement | null = null;
	private fabInterval: number | null = null;

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
		if (!Platform.isMobileApp || !this.settings.showFloatingButton || this.fabEl) return;

		const fab = activeDocument.body.createDiv({ cls: "ai-fab" });
		const svgns = "http://www.w3.org/2000/svg";
		const svg = activeDocument.createElementNS(svgns, "svg");
		svg.setAttribute("width", "40"); svg.setAttribute("height", "40");
		svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("fill", "none");
		svg.setAttribute("stroke", "#fff"); svg.setAttribute("stroke-width", "1.5");
		svg.setAttribute("stroke-linecap", "round");
		[4, 7, 10].forEach((r, i) => {
			const c = activeDocument.createElementNS(svgns, "circle");
			c.setAttribute("cx", "12"); c.setAttribute("cy", "12");
			c.setAttribute("r", String(r));
			c.setAttribute("opacity", String([0.55, 0.35, 0.18][i]));
			svg.appendChild(c);
		});
		const dot = activeDocument.createElementNS(svgns, "circle");
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
		this.fabInterval = this.registerInterval(window.setInterval(() => {
			if (!this.settings.showFloatingButton) return;
			if (!activeDocument.body.contains(fab)) {
				activeDocument.body.appendChild(fab);
			}
		}, 3000));
	}

	private removeFab() {
		if (this.fabInterval !== null) {
			window.clearInterval(this.fabInterval);
			this.fabInterval = null;
		}
		this.fabEl?.remove();
		this.fabEl = null;
	}

	refreshFloatingButton(show: boolean) {
		if (show) this.addFab();
		else this.removeFab();
	}

	async loadSettings() {
		const saved = await this.loadData() as Partial<AudioInboxSettings> | null;
		this.settings = Object.assign({}, DEFAULTS, saved || {});
		if (this.settings.sttProvider !== "doubao") this.settings.sttProvider = "compatible";
		if (this.settings.doubaoAuthMode !== "app-token") this.settings.doubaoAuthMode = "api-key";
		// Preserve the endpoint used by existing Doubao installations.
		if (saved?.sttProvider === "doubao" && saved.doubaoMode === undefined) this.settings.doubaoMode = "flash";
		if (this.settings.doubaoMode !== "flash") this.settings.doubaoMode = "standard";
		if (!Array.isArray(this.settings.promptHistory)) this.settings.promptHistory = [];
		let migrated = false;
		// The old stored default was 5 minutes. Move that default to the requested one-hour limit.
		if (saved?.maxRecordMinutes === 5) {
			this.settings.maxRecordMinutes = 60;
			migrated = true;
		}
		// DeepSeek retired this model ID; migrate only when the configured endpoint is DeepSeek.
		if (this.settings.aiModel === "deepseek-chat" && this.settings.aiApiUrl.includes("api.deepseek.com")) {
			this.settings.aiModel = "deepseek-v4-flash";
			migrated = true;
		}
		// One-time migration for legacy prompts ONLY (old "## ✅ / ## 📋" format).
		// Never overwrite a user-edited prompt: this used to run on every load
		// and silently reset custom prompts back to the default after restart.
		const p = this.settings.summaryPrompt || "";
		const legacyFormat = !!saved && saved.promptVersion === undefined
			&& !p.includes("### 类型") && !p.includes("### 标题")
			&& (p.includes("## ✅") || p.includes("## 📋") || p.includes("## 总结") || p.includes("## 待办"));
		if (legacyFormat) {
			this.settings.summaryPrompt = DEFAULTS.summaryPrompt;
			this.settings.promptVersion = 1;
			await this.saveSettings();
		}
		// New installs and settings without an explicit choice retain their audio.
		if (saved && saved.deleteAfterProcess === undefined) {
			this.settings.deleteAfterProcess = false;
			migrated = true;
		}
		if (migrated) await this.saveSettings();
	}
	async saveSettings() { await this.saveData(this.settings); }

	/** Record a prompt version into history — most recent first, dedup, max 20 entries. */
	async pushPromptHistory(prompt: string): Promise<void> {
		const trimmed = (prompt || "").trim();
		if (!trimmed) return;
		const list = Array.isArray(this.settings.promptHistory) ? this.settings.promptHistory : [];
		const next = [trimmed, ...list.filter(x => (x || "").trim() !== trimmed)];
		this.settings.promptHistory = next.slice(0, 20);
		await this.saveSettings();
	}

	// ===== MAIN FLOW: Record → STT → AI → Note =====

	async startRecordFlow() {
		if (this.isBusy) { new Notice("⏳ 正在处理中..."); return; }
		if (!this.validateProcessingSettings()) return;

		this.isBusy = true;
		const statusEl = this.addStatusBarItem();

		try {
			// 1. Record
			const blob = await new Promise<Blob | null>(resolve => {
				new RecordModal(
					this.app,
					resolve,
					Math.round(this.settings.maxRecordMinutes * 60),
					this.settings.autoStopOnLimit
				).open();
			});

			if (!blob) { new Notice("录音已取消"); return; }

			// 2. Save audio
			statusEl.setText("📁 保存录音...");
			const audioPath = await this.saveAudio(blob);
			if ((blob as Blob & { audioInboxInterrupted?: boolean }).audioInboxInterrupted) {
				throw new Error(`录音设备意外中断，已保存已录部分到 ${audioPath}；请检查麦克风和应用前台状态`);
			}

			// 3. Speech to text
			statusEl.setText("🎧 语音转文字中，长录音可能需要几分钟...");
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

			// 5. Parse AI response — save to memo/todo only
			const parsed = parseAIResponse(summary);
			if (!hasGeneratedContent(parsed)) throw new Error("AI 未生成可保存的笔记，原录音已保留");

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
		}
	}

	// ===== PROCESS INBOX (pre-recorded files) =====

	async processInbox() {
		if (this.isBusy) { new Notice("⏳ 正在处理中..."); return; }
		if (!this.validateProcessingSettings()) return;

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
				const ext = (fn.split(".").pop() || "webm").toLowerCase();
				let mime = "audio/webm";
				if (ext === "m4a" || ext === "mp4") mime = "audio/mp4";
				else if (ext === "mp3") mime = "audio/mpeg";
				else if (ext === "wav") mime = "audio/wav";
				else if (ext === "ogg") mime = "audio/ogg";
				else if (ext === "aac") mime = "audio/aac";
				else if (ext === "flac") mime = "audio/flac";

				const blob = new Blob([buf], { type: mime });
				const txt = await this.callSTT(blob);
				if (!txt || txt.trim().length < 2) throw new Error("未识别到内容");

				const summary = await this.callAI(txt);
				const parsed = parseAIResponse(summary);
				if (!hasGeneratedContent(parsed)) throw new Error("AI 未生成可保存的笔记，原录音已保留");
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

	private getSTTSettingsError(): string | null {
		if (this.settings.sttProvider === "doubao") {
			if (this.settings.doubaoAuthMode === "app-token") {
				return this.settings.doubaoAppId.trim() && this.settings.doubaoAccessToken.trim()
					? null : "请先在语音转文字设置中填写豆包 APP ID 和 Access Token";
			}
			return this.settings.doubaoApiKey.trim() ? null : "请先在语音转文字设置中填写豆包语音 API Key";
		}
		if (!this.settings.sttApiKey.trim()) return "请先在语音转文字设置中填写 STT API Key";
		if (!this.settings.sttApiUrl.trim() || !this.settings.sttModel.trim()) return "请先填写 STT API 地址和模型";
		return null;
	}

	private validateProcessingSettings(): boolean {
		const error = this.getSTTSettingsError() || (!this.settings.aiApiKey.trim() ? "请先填写 AI 总结的 API Key" : null);
		if (!error) return true;
		new Notice(`⚠️ ${error}`);
		return false;
	}

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
		const mime = (blob.type || "audio/webm").toLowerCase();
		const ext = mime.includes("mp4") ? "m4a" : mime.includes("mpeg") ? "mp3"
			: mime.includes("ogg") ? "ogg" : mime.includes("wav") ? "wav" : "webm";
		const fn = `录音-${fmtDate(now)}-${fmtTime(now)}.${ext}`;
		const fp = normalizePath(`${dir}/${fn}`);
		await this.app.vault.createBinary(fp, await blob.arrayBuffer());
		return fp;
	}

	private async callSTT(audioBlob: Blob): Promise<string> {
		const settingsError = this.getSTTSettingsError();
		if (settingsError) throw new Error(settingsError);
		const isDoubao = this.settings.sttProvider === "doubao";
		if (isDoubao && audioBlob.size > DOUBAO_MAX_AUDIO_BYTES) {
			throw new Error("豆包语音识别音频不能超过 100 MB，请缩短录音或压缩后重试");
		}
		// WAV is supported by both providers; mobile recordings may be MP4/WebM.
		let finalBlob = audioBlob;
		let finalMime = audioBlob.type || "audio/webm";
		const sourceMime = finalMime.split(";")[0].trim().toLowerCase();
		const isWav = /^(audio\/(x-)?wav|audio\/wave)$/.test(sourceMime);
		const isMp3 = sourceMime === "audio/mpeg" || sourceMime === "audio/mp3";
		let finalExt = isWav ? "wav" : isMp3 ? "mp3" : sourceMime === "audio/mp4" ? "m4a"
			: sourceMime === "audio/ogg" ? "ogg" : sourceMime === "audio/flac" ? "flac" : sourceMime === "audio/aac" ? "aac" : "webm";

		const compatibleCompressedFormat = /audio\/(webm|mp4|ogg|mpeg|mp3|flac|aac)/i.test(finalMime);
		if (isDoubao ? (!isWav && !isMp3) : (!compatibleCompressedFormat && !isWav)) {
			try {
				finalBlob = await this.convertToWav(audioBlob);
				finalExt = "wav";
				finalMime = "audio/wav";
			} catch (e) {
				console.warn("AudioInbox: WAV conversion failed, sending original format", e);
			}
		}
		if (isDoubao) return this.callDoubaoSTT(finalBlob);

		// Manual multipart body (requestUrl compatible, works on mobile)
		const boundary = "----AiInbox" + Math.random().toString(36).slice(2);
		const parts: BlobPart[] = [];
		const line = (s: string) => parts.push(s);
		line(`--${boundary}\r\n`);
		line(`Content-Disposition: form-data; name="file"; filename="audio.${finalExt}"\r\n`);
		line(`Content-Type: ${finalMime}\r\n\r\n`);
		parts.push(finalBlob);
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

		const body = await new Blob(parts).arrayBuffer();

		let resp: RequestUrlResponse;
		try {
			resp = await requestUrl({
				url: this.settings.sttApiUrl.trim(),
				method: "POST",
				headers: {
					"Authorization": `Bearer ${this.settings.sttApiKey.trim()}`,
					"Content-Type": `multipart/form-data; boundary=${boundary}`,
				},
				body,
			});
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err);
			const st = (err as { status?: number })?.status || 0;
			const m = /status[:\s]+(\d{3})/i.exec(errMsg);
			const status = st || (m ? Number(m[1]) : 0);
			console.error("AudioInbox: STT request failed:", errMsg);
			if (status === 413) throw new Error("录音超过语音识别服务的文件大小限制，请缩短录音或更换服务商");
			if (status === 415) throw new Error("语音识别服务不支持当前录音格式，请更换兼容的接口");
			if (status === 402 || errMsg.includes("balance") || errMsg.includes("30001") || errMsg.includes("4032")) {
				throw new Error("语音识别服务额度不足，请检查服务商账户");
			}
			if (status === 401 || errMsg.includes("401") || errMsg.includes("invalid") || errMsg.includes("Api key")) {
				throw new Error("STT API Key 无效，请检查设置");
			}
			throw new Error(`STT 请求失败${status ? ` (${status})` : ""}：${errMsg.substring(0, 100)}`);
		}

		if (resp.status !== 200) {
			const errStr: string = resp.text || (resp.json ? JSON.stringify(resp.json) : "");
			console.error("AudioInbox: STT error response:", errStr);
			if (resp.status === 413) throw new Error("录音超过语音识别服务的文件大小限制，请缩短录音或更换服务商");
			if (resp.status === 415) throw new Error("语音识别服务不支持当前录音格式，请更换兼容的接口");
			if (errStr.includes("balance") || errStr.includes("30001") || errStr.includes("4032")) {
				throw new Error("语音识别服务额度不足，请检查服务商账户");
			}
			if (errStr.includes("invalid") || errStr.includes("Api key") || errStr.includes("401")) {
				throw new Error("STT API Key 无效，请检查设置");
			}
			if (errStr.includes("20015") || errStr.toLowerCase().includes("format") || errStr.toLowerCase().includes("decode")) {
				throw new Error("服务商不接受当前音频格式；请换用支持该格式的转写接口");
			}
			throw new Error(`STT 失败 (${resp.status}): ${errStr.substring(0, 100)}`);
		}

		// SiliconFlow returns JSON such as {"text":"..."}; other compatible
		// providers may return plain text. Extract the transcript rather than
		// passing the JSON wrapper (or an empty transcript) to the summary model.
		const raw = resp.text || "";
		let parsed: unknown;
		try {
			parsed = resp.json as unknown;
		} catch {
			try { parsed = JSON.parse(raw) as unknown; } catch { /* Plain text response. */ }
		}
		let result = "";
		if (parsed && typeof parsed === "object") {
			if (!("text" in parsed) || typeof (parsed as { text?: unknown }).text !== "string") {
				throw new Error("语音识别接口返回了无法识别的 JSON 格式，原录音已保留");
			}
			result = (parsed as { text: string }).text;
		} else if (typeof parsed === "string") {
			result = parsed;
		} else if (raw.trim().startsWith("<")) {
			throw new Error("语音识别接口返回了网页而非转写结果，原录音已保留");
		} else {
			result = raw;
		}
		if (!result.trim()) {
			const body = parsed && typeof parsed === "object" ? parsed as { usage?: { seconds?: unknown } } : null;
			const seconds = typeof body?.usage?.seconds === "number" ? body.usage.seconds : "unknown";
			console.warn("AudioInbox: STT returned empty transcript", { serverSeconds: seconds, audioBytes: audioBlob.size, mimeType: audioBlob.type });
		}
		return result;
	}

	private async callDoubaoSTT(audioBlob: Blob): Promise<string> {
		const standard = this.settings.doubaoMode === "standard";
		const mime = audioBlob.type.split(";")[0].trim().toLowerCase();
		const supported = /^(audio\/(x-)?wav|audio\/wave|audio\/mpeg|audio\/mp3)$/.test(mime)
			|| (mime === "audio/ogg" && /codecs\s*=\s*"?opus\b/i.test(audioBlob.type));
		if (!supported) throw new Error("无法将录音转换为豆包支持的格式，请使用 WAV、MP3 或 OGG Opus 音频重试");
		if (audioBlob.size > DOUBAO_MAX_AUDIO_BYTES) throw new Error("转换后的豆包语音识别音频超过 100 MB，请缩短录音后重试");

		// Encode with the browser API rather than Node Buffer (also works on mobile).
		const audioData = await new Promise<string>((resolve, reject) => {
			const reader = new FileReader();
			reader.onerror = () => reject(new Error("读取豆包语音识别音频失败"));
			reader.onabort = () => reject(new Error("读取豆包语音识别音频已取消"));
			reader.onload = () => {
				if (typeof reader.result !== "string" || reader.result.indexOf(",") < 0) {
					reject(new Error("豆包语音识别音频编码失败"));
					return;
				}
				resolve(reader.result.slice(reader.result.indexOf(",") + 1));
			};
			reader.readAsDataURL(audioBlob);
		});

		const bytes = new Uint8Array(16);
		window.crypto.getRandomValues(bytes);
		bytes[6] = (bytes[6] & 0x0f) | 0x40;
		bytes[8] = (bytes[8] & 0x3f) | 0x80;
		const hex = Array.from(bytes, b => ("0" + b.toString(16)).slice(-2)).join("");
		const requestId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			"X-Api-Resource-Id": standard ? "volc.seedasr.auc" : DOUBAO_RESOURCE_ID,
			"X-Api-Request-Id": requestId,
			"X-Api-Sequence": "-1",
		};
		if (this.settings.doubaoAuthMode === "app-token") {
			headers["X-Api-App-Key"] = this.settings.doubaoAppId.trim();
			headers["X-Api-Access-Key"] = this.settings.doubaoAccessToken.trim();
		} else {
			headers["X-Api-Key"] = this.settings.doubaoApiKey.trim();
		}

		let resp: RequestUrlResponse;
		try {
			resp = await requestUrl({
				url: standard ? `${DOUBAO_STANDARD_URL}/submit` : DOUBAO_STT_URL,
				method: "POST",
				headers,
				body: JSON.stringify({
					user: { uid: "audio-inbox" },
					audio: { data: audioData, format: mime === "audio/ogg" ? "ogg" : /mpeg|mp3/.test(mime) ? "mp3" : "wav" },
					request: { model_name: "bigmodel", enable_itn: true, enable_punc: true },
				}),
				throw: false,
			});
		} catch {
			throw new Error("豆包语音识别请求失败，请检查网络连接后重试");
		}

		let code = this.checkDoubaoResponse(resp, standard);
		if (standard && code !== "20000003") {
			// Submission has no transcript. Poll the same task without re-uploading audio.
			const deadline = Date.now() + 5 * 60 * 1000;
			let completed = false;
			for (let attempt = 0; attempt < 150; attempt++) {
				await new Promise<void>(resolve => window.setTimeout(resolve, 2000));
				if (Date.now() >= deadline) break;
				try {
					resp = await requestUrl({ url: `${DOUBAO_STANDARD_URL}/query`, method: "POST", headers, body: "{}", throw: false });
				} catch {
					throw new Error("豆包语音识别结果查询失败，请检查网络连接后重试；原音频已保留");
				}
				code = this.checkDoubaoResponse(resp, true);
				if (code !== "20000001" && code !== "20000002") { completed = true; break; }
			}
			if (!completed) {
				throw new Error(`豆包标准版识别等待超时，原音频已保留，请稍后重试；任务 ID：${requestId}`);
			}
		}
		if (code === "20000003") return "";
		let data: { result?: { text?: unknown } } | null;
		try {
			data = JSON.parse(resp.text) as { result?: { text?: unknown } } | null;
		} catch {
			throw new Error("豆包语音识别返回了无效结果，请稍后重试");
		}
		if (!data || !data.result || typeof data.result.text !== "string") {
			throw new Error("豆包语音识别结果缺少文字，请稍后重试");
		}
		return data.result.text.trim();
	}

	private checkDoubaoResponse(resp: RequestUrlResponse, standard: boolean): string {
		const getHeader = (name: string): string => {
			const key = Object.keys(resp.headers).find(k => k.toLowerCase() === name);
			return key ? resp.headers[key] : "";
		};
		const code = getHeader("x-api-status-code");
		const errorDetails = (): string => {
			let message = getHeader("x-api-message");
			if (!message) {
				try {
					const body = JSON.parse(resp.text) as {
						message?: unknown; msg?: unknown; error?: string | { message?: unknown };
					} | null;
					const candidate = body?.message || body?.msg
						|| (typeof body?.error === "string" ? body.error : body?.error?.message);
					if (typeof candidate === "string") message = candidate;
				} catch {
					// Some gateways return a plain-text error instead of JSON.
					if (!/^\s*</.test(resp.text)) message = resp.text;
				}
			}
			// Never expose a credential if a server echoes it in an error message.
			for (const value of [this.settings.doubaoApiKey, this.settings.doubaoAppId, this.settings.doubaoAccessToken]) {
				const credential = value.trim();
				if (credential) message = message.split(credential).join("[已隐藏凭证]");
			}
			message = message.replace(/\s+/g, " ").slice(0, 240);
			const logId = getHeader("x-tt-logid").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 100);
			return `HTTP ${resp.status}${code ? ` / ${code}` : ""}${message ? `：${message}` : ""}${logId ? `；日志 ID：${logId}` : ""}`;
		};

		if (resp.status === 401) {
			throw new Error(`豆包语音识别鉴权失败，请核对语音服务凭证和鉴权方式。\n${errorDetails()}`);
		}
		if (resp.status === 403) {
			throw new Error(`豆包语音识别无权限或凭证无效，请检查同一项目/应用是否开通${standard ? "录音文件识别标准版 2.0（volc.seedasr.auc）" : "录音文件极速版（volc.bigasr.auc_turbo）"}。\n${errorDetails()}`);
		}
		if (resp.status === 402) throw new Error(`豆包语音识别余额不足，请前往火山引擎控制台检查余额。\n${errorDetails()}`);
		if (resp.status === 429) throw new Error(`豆包语音识别请求过于频繁，请稍后重试。\n${errorDetails()}`);
		if (resp.status !== 200) throw new Error(`豆包语音识别请求失败。\n${errorDetails()}`);

		if (code === "20000003" || (standard && (code === "20000001" || code === "20000002"))) return code;
		if (code !== "20000000") {
			if (code === "45000151") throw new Error("豆包语音识别不支持当前音频格式，请使用 WAV、MP3 或 OGG Opus");
			if (code === "45000002") throw new Error("豆包语音识别收到空音频，请重新录音");
			if (code === "55000031") throw new Error("豆包语音识别服务繁忙，请稍后重试");
			throw new Error(`豆包语音识别失败${code ? "" : "（缺少服务状态码）"}。\n${errorDetails()}`);
		}

		return code;
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
		let resp: RequestUrlResponse;
		try {
			const useDeepSeekReasoning = new URL(this.settings.aiApiUrl).hostname === "api.deepseek.com"
				&& /^(deepseek-v4-flash|deepseek-v4-pro)$/.test(this.settings.aiModel);
			resp = await requestUrl({
				url: this.settings.aiApiUrl,
				method: "POST",
				headers: { "Content-Type": "application/json", "Authorization": `Bearer ${this.settings.aiApiKey}` },
				body: JSON.stringify({
					model: this.settings.aiModel,
					messages: [
						{ role: "system", content: `${this.settings.summaryPrompt}\n\n准确性要求：只依据转写内容；不得补造原文未明确提到的事实、人物、时间或待办。只修正能由上下文明确判断的识别错误；不确定的信息标注“待确认”。请按“### 标题、### 类型、### 总结、### 待办事项、### 备忘内容”分节；标题不超过十个汉字且不含编号或时间。待办只写明确要求将来执行的动作；已完成的事、现状、原则说明和测试范围写入备忘。条件性安排须保留条件。` },
						{ role: "user", content: text },
					],
					max_tokens: useDeepSeekReasoning ? 12000 : 6000,
					...(useDeepSeekReasoning
						? { thinking: { type: "enabled" }, reasoning_effort: "low" }
						: { temperature: 0.2 }),
				}),
			});
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err);
			const st = (err as { status?: number })?.status || 0;
			const m = /status[:\s]+(\d{3})/i.exec(errMsg);
			const status = st || (m ? Number(m[1]) : 0);
			if (status === 402 || errMsg.includes("402")) {
				throw new Error("AI 服务额度不足，请检查服务商账户");
			}
			throw new Error(`AI 请求失败${status ? ` (${status})` : ""}：${errMsg.substring(0, 100)}`);
		}
		if (resp.status !== 200) {
			if (resp.status === 402) throw new Error("AI 服务额度不足，请检查服务商账户");
			throw new Error(`AI 请求失败 (${resp.status})`);
		}
		let json: { choices?: Array<{ finish_reason?: string; message?: { content?: string } }> };
		try { json = resp.json as typeof json; }
		catch { throw new Error("AI 服务返回了无法解析的内容，原录音已保留"); }
		const choice = json.choices?.[0];
		if (choice?.finish_reason === "length") {
			throw new Error("AI 总结达到输出长度上限，原录音已保留；请缩短录音或更换支持更长输出的模型");
		}
		const content = choice?.message?.content || "";
		if (!content.trim()) throw new Error("AI 总结返回空内容，原录音已保留");
		return content;
	}

	// ===== SAVE: 四级目录 — VoiceNotes/月/日/单文件 =====

	/** Save a single memo as an independent file under VoiceNotes/YYYY-MM/YYYY-MM-DD/ */
	private async saveMemo(transcript: string, memoContent: string, audioPath: string, title: string) {
		const { dir, ds, ts, timeSlug } = this.datePath();
		await this.ensureFolder(dir);
		const safeTitle = title ? title.replace(/[\\/:*?"<>|]/g, "").trim() : "";

		let fn = safeTitle ? `备忘-${safeTitle}.md` : `备忘.md`;
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
				fn = safeTitle ? `备忘-${safeTitle}-${timeSlug}.md` : `备忘-${timeSlug}.md`;
				np = normalizePath(`${dir}/${fn}`);
			}
			await adapter.write(np, content);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			console.error('AudioInbox: saveMemo error', e);
			new Notice(`❌ 备忘录保存失败: ${msg}`, 8000);
			throw e;
		}
	}

	/** Save todo items as a single file under VoiceNotes/YYYY-MM/YYYY-MM-DD/ */
	private async saveTodos(todos: string[], title: string) {
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
		} catch (e) {
			console.error('AudioInbox: saveTodos error', e);
			throw e;
		}

		// Sync to clean.txt (append + dedup) and clipboard for iOS Shortcuts
		const clean: string[] = [];
		for (const t of todos) {
			const s = t.replace(/^- \[ \] /, "").trim();
			if (s && s !== "无") clean.push(s);
		}
		if (clean.length > 0) {
			void this.syncCleanTodos(clean);
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
		this.removeFab();
	}
}

// ==================== UTILS ====================

function hasGeneratedContent(parsed: ParsedAI): boolean {
	const hasMemo = (parsed.type === "memo" || parsed.type === "mixed") && parsed.memo.trim().length > 0;
	const hasTodos = (parsed.type === "reminder" || parsed.type === "mixed")
		&& parsed.todos.some(todo => !/^-\s*\[\s*\]\s*无\s*$/.test(todo));
	return hasMemo || hasTodos;
}

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
				const todo = line.trim();
				if (!/^-\s*\[ \]\s*无(?:$|[（(])/.test(todo)) todos.push(todo);
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

	// Sanitize title: reject timestamps, dates, pure numbers
	if (title && /^\d{1,2}[：:]\d{2}$|^\d{4}-\d{2}-\d{2}$|^\d{1,2}点|^周[一二三四五六日]|^星期|^[上下]午/.test(title)) {
		title = "";
	}
	// If title is empty or bad, extract the first meaningful sentence from summary
	if (!title && summary.trim()) {
		const firstLine = summary.trim().split("\n")[0].replace(/^[-*\d.]+\s*/, "").replace(/[\\/:*?"<>|]/g, "").trim();
		if (firstLine.length > 1) {
			title = firstLine.substring(0, 10);
		}
	}

	return { type, todos, memo: memo.trim(), summary: summary.trim(), title };
}

// ==================== SETTINGS TAB ====================

class AudioInboxSettingTab extends PluginSettingTab {
	plugin: AudioInboxPlugin;
	private promptText: TextAreaComponent | null = null;
	private histDropdown: DropdownComponent | null = null;
	constructor(app: App, plugin: AudioInboxPlugin) { super(app, plugin); this.plugin = plugin; }

	display() {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName("🎤 语音笔记设置").setHeading();

		containerEl.createDiv({
			cls: "audio-inbox-guide",
			text: "⏱️ 默认录音上限 60 分钟。兼容接口保留压缩录音；豆包会将 WebM/MP4 转为 WAV，并检查转换后 100 MB 上限。服务商的时长、文件大小和格式限制各不相同；录音时请保持 Obsidian 在前台，手机锁屏可能中断。",
		});

		new Setting(containerEl)
			.setName("最长录音时长（分钟）")
			.setDesc("默认 60 分钟，可设为 0 手动停止。实际可处理时长仍取决于所选语音识别 API 的限制。")
			.addText(t => {
				t.inputEl.type = "number";
				t.inputEl.min = "0";
				t.inputEl.max = "120";
				t.inputEl.step = "1";
				t.setValue(String(this.plugin.settings.maxRecordMinutes));
				t.onChange(async v => {
					const n = parseFloat(v);
					if (isNaN(n) || n < 0) return;
					this.plugin.settings.maxRecordMinutes = Math.min(120, n);
					await this.plugin.saveSettings();
				});
			});
		new Setting(containerEl)
			.setName("到点自动结束录音")
			.setDesc("开启后到达时长上限自动停止录音并进入处理流程；关闭则到点只提醒、不强制停止。")
			.addToggle(t =>
				t.setValue(this.plugin.settings.autoStopOnLimit).onChange(async v => {
					this.plugin.settings.autoStopOnLimit = v;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("显示手机悬浮球")
			.setDesc("仅在 Obsidian 手机端显示；关闭后可从命令面板或侧边栏开始录音。")
			.addToggle(t => t.setValue(this.plugin.settings.showFloatingButton).onChange(async v => {
				this.plugin.settings.showFloatingButton = v;
				await this.plugin.saveSettings();
				if (v) this.plugin.refreshFloatingButton(true);
				else this.plugin.refreshFloatingButton(false);
			}));

		// STT
		new Setting(containerEl).setName("语音转文字 (STT)").setHeading();
		new Setting(containerEl).setName("语音识别服务")
			.setDesc("各服务的凭证分别保存，切换后无需重新填写。")
			.addDropdown(dd => dd
				.addOption("compatible", "兼容接口（硅基流动 / Whisper 等）")
				.addOption("doubao", "豆包语音")
				.setValue(this.plugin.settings.sttProvider)
				.onChange(async v => {
					this.plugin.settings.sttProvider = v === "doubao" ? "doubao" : "compatible";
					await this.plugin.saveSettings();
					this.display();
				}));

		if (this.plugin.settings.sttProvider === "doubao") {
			new Setting(containerEl).setName("豆包识别模式")
				.setDesc("控制台开通「豆包录音文件识别模型 2.0」时选择标准版 2.0。")
				.addDropdown(dd => dd
					.addOption("standard", "标准版 2.0（推荐）")
					.addOption("flash", "极速版（需单独开通）")
					.setValue(this.plugin.settings.doubaoMode)
					.onChange(async v => {
						this.plugin.settings.doubaoMode = v === "flash" ? "flash" : "standard";
						await this.plugin.saveSettings();
					}));
			containerEl.createDiv({
				cls: "audio-inbox-guide",
				text: "填写已开通所选语音识别服务的同一项目（旧版为同一应用）的凭证。标准版 2.0 使用 volc.seedasr.auc，提交后等待识别结果；极速版使用 volc.bigasr.auc_turbo。需有有效额度或余额；豆包聊天会员、聊天模型 Key、流式识别及语音合成权限不能替代录音文件识别权限。只粘贴凭证值，不要粘贴 curl 示例。录音发送至火山引擎，转写文字再发送至所配置的 AI 总结服务。标准版最多等待约 5 分钟，超时保留原录音；重试会提交新任务，可能再次计费。",
			});
			new Setting(containerEl).setName("豆包语音鉴权方式").addDropdown(dd => dd
				.addOption("api-key", "API Key（新版控制台）")
				.addOption("app-token", "APP ID + Access Token（旧版控制台）")
				.setValue(this.plugin.settings.doubaoAuthMode)
				.onChange(async v => {
					this.plugin.settings.doubaoAuthMode = v === "app-token" ? "app-token" : "api-key";
					await this.plugin.saveSettings();
					this.display();
				}));
			if (this.plugin.settings.doubaoAuthMode === "app-token") {
				new Setting(containerEl).setName("豆包语音 APP ID").addText(t =>
					t.setValue(this.plugin.settings.doubaoAppId).onChange(async v => {
						this.plugin.settings.doubaoAppId = v; await this.plugin.saveSettings();
					}));
				new Setting(containerEl).setName("豆包语音 Access Token").addText(t => {
					t.setValue(this.plugin.settings.doubaoAccessToken); t.inputEl.type = "password";
					t.onChange(async v => { this.plugin.settings.doubaoAccessToken = v; await this.plugin.saveSettings(); });
				});
			} else {
				new Setting(containerEl).setName("豆包语音 API Key").addText(t => {
					t.setValue(this.plugin.settings.doubaoApiKey); t.inputEl.type = "password";
					t.onChange(async v => { this.plugin.settings.doubaoApiKey = v; await this.plugin.saveSettings(); });
				});
			}
		} else {
			containerEl.createDiv({
				cls: "audio-inbox-guide",
				text: "填写支持 multipart 音频上传、Bearer Key 鉴权和 text 文字响应的 /audio/transcriptions 完整地址、模型及 API Key。默认使用硅基流动 SenseVoiceSmall，服务商需支持当前音频格式。",
			});
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
		}

		// AI
		new Setting(containerEl).setName("AI 总结 API").setDesc("填写兼容 /chat/completions 请求格式的完整地址、模型和 API Key；不要求使用 OpenAI，服务商可自行选择。").setHeading();

		new Setting(containerEl).setName("AI API Key").addText(t => {
			t.setValue(this.plugin.settings.aiApiKey); t.inputEl.type = "password";
			t.onChange(async v => { this.plugin.settings.aiApiKey = v; await this.plugin.saveSettings(); });
		});
		new Setting(containerEl).setName("API 地址").addText(t =>
			t.setValue(this.plugin.settings.aiApiUrl).onChange(async v => { this.plugin.settings.aiApiUrl = v; await this.plugin.saveSettings(); }));
		new Setting(containerEl).setName("模型").addText(t =>
			t.setValue(this.plugin.settings.aiModel).onChange(async v => { this.plugin.settings.aiModel = v; await this.plugin.saveSettings(); }));
		new Setting(containerEl)
			.setName("总结指令（提示词）")
			.setDesc("可自由编辑，改动会自动保存，重启不会丢失；编辑前的旧版本会自动存入下方历史。")
			.addTextArea(t => { this.bindPromptEditor(t); });

		new Setting(containerEl)
			.setName("保存当前提示词到历史")
			.setDesc("手动把当前正在使用的提示词存一份副本，方便以后切换回来。")
			.addButton(b => this.bindSaveButton(b));

		new Setting(containerEl)
			.setName("恢复默认提示词")
			.setDesc("恢复插件内置默认提示词；当前提示词会自动存入历史。")
			.addButton(b => this.bindRestoreButton(b));

		const hist = this.plugin.settings.promptHistory || [];
		if (hist.length > 0) {
			new Setting(containerEl)
				.setName("提示词历史")
				.setDesc("选择一条历史提示词恢复使用；最多保留 20 条，最近使用在前。")
				.addDropdown(dd => { this.bindHistoryDropdown(dd); });
		}

		// Output
		new Setting(containerEl).setName("输出").setHeading();
		new Setting(containerEl).setName("录音保存目录").addText(t =>
			t.setValue(this.plugin.settings.inboxFolder).onChange(async v => { this.plugin.settings.inboxFolder = v; await this.plugin.saveSettings(); }));
		new Setting(containerEl).setName("笔记输出目录").addText(t =>
			t.setValue(this.plugin.settings.outputFolder).onChange(async v => { this.plugin.settings.outputFolder = v; await this.plugin.saveSettings(); }));
		new Setting(containerEl).setName("显示原始文本").addToggle(t =>
			t.setValue(this.plugin.settings.showTranscript).onChange(async v => { this.plugin.settings.showTranscript = v; await this.plugin.saveSettings(); }));
		new Setting(containerEl).setName("处理后删除录音文件").setDesc("开启后成功生成笔记时将原音频移至回收站；关闭则保留录音文件。").addToggle(t =>
			t.setValue(this.plugin.settings.deleteAfterProcess).onChange(async v => { this.plugin.settings.deleteAfterProcess = v; await this.plugin.saveSettings(); }));
	}

	private historyLabel(prompt: string, idx: number, total: number): string {
		const label = (prompt.replace(/\s+/g, " ").trim().slice(0, 22) || "（空提示词）");
		return `${total - idx}. ${label}`;
	}

	private bindPromptEditor(t: TextAreaComponent): void {
		this.promptText = t;
		t.setValue(this.plugin.settings.summaryPrompt);
		t.inputEl.rows = 14;
		let lastFocusedPrompt = "";
		t.inputEl.addEventListener("focus", () => { lastFocusedPrompt = t.getValue(); });
		t.inputEl.addEventListener("blur", () => {
			const cur = t.getValue();
			if (lastFocusedPrompt.trim() && cur.trim() !== lastFocusedPrompt.trim()) {
				void this.plugin.pushPromptHistory(lastFocusedPrompt);
				this.refreshHistoryDropdown();
			}
		});
		t.onChange(async v => { this.plugin.settings.summaryPrompt = v; await this.plugin.saveSettings(); });
	}

	private bindSaveButton(b: ButtonComponent): void {
		b.setButtonText("保存到历史").onClick(async () => {
			const cur = this.plugin.settings.summaryPrompt || "";
			if (!cur.trim()) { new Notice("⚠️ 提示词为空，无需保存"); return; }
			await this.plugin.pushPromptHistory(cur);
			this.refreshHistoryDropdown();
			new Notice("✅ 已保存到提示词历史");
		});
	}

	private bindRestoreButton(b: ButtonComponent): void {
		b.setButtonText("恢复默认").onClick(async () => {
			const cur = this.plugin.settings.summaryPrompt || "";
			if (cur.trim() && cur !== DEFAULTS.summaryPrompt) await this.plugin.pushPromptHistory(cur);
			this.plugin.settings.summaryPrompt = DEFAULTS.summaryPrompt;
			await this.plugin.saveSettings();
			this.promptText?.setValue(DEFAULTS.summaryPrompt);
			this.refreshHistoryDropdown();
			new Notice("✅ 已恢复默认提示词");
		});
	}

	private bindHistoryDropdown(dd: DropdownComponent): void {
		this.histDropdown = dd;
		dd.addOption("", "— 选择历史提示词 —");
		const hist = this.plugin.settings.promptHistory || [];
		hist.forEach((p, idx) => { dd.addOption(String(idx), this.historyLabel(p, idx, hist.length)); });
		dd.onChange(async v => {
			if (v === "") return;
			const idx = Number(v);
			const p = (this.plugin.settings.promptHistory || [])[idx];
			dd.setValue("");
			if (p === undefined) return;
			this.plugin.settings.summaryPrompt = p;
			await this.plugin.saveSettings();
			this.promptText?.setValue(p);
			new Notice("✅ 已恢复历史提示词");
		});
	}

	private refreshHistoryDropdown(): void {
		const dd = this.histDropdown;
		if (!dd) return;
		const prev = dd.getValue();
		dd.selectEl.empty();
		dd.addOption("", "— 选择历史提示词 —");
		const hist = this.plugin.settings.promptHistory || [];
		hist.forEach((p, idx) => { dd.addOption(String(idx), this.historyLabel(p, idx, hist.length)); });
		dd.setValue(prev);
	}
}

function pad(n: number): string { return n < 10 ? "0" + n : String(n); }
function fmtDate(d: Date) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function fmtTime(d: Date) { return `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`; }
