# 🎤 Audio Inbox

> **One-click voice recording → speech-to-text → AI summary**, saved as Markdown inside your vault.
> Desktop & mobile · Configurable speech recognition and AI services · Bring your own API credentials

[![Obsidian Downloads](https://img.shields.io/badge/dynamic/json?logo=obsidian&query=%24%5B%22audio-inbox%22%5D.downloads&url=https://raw.githubusercontent.com/obsidianmd/obsidian-releases/community-plugins-stats.json&label=downloads)](https://obsidian.md/plugins?id=audio-inbox)
[![GitHub release](https://img.shields.io/github/v/release/andsea007/obsidian-audio-inbox)](https://github.com/andsea007/obsidian-audio-inbox/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> ⭐ If this plugin helps you, a Star is appreciated!

---

## ✨ Features

- 🎙️ **One-click recording** — tap the mic, speak, stop. No extra steps.
- ⏱️ **Long recordings** — record up to **60 minutes** by default (configurable), compressed as WebM/Opus so hour-long audio stays small.
- 🧠 **Smart transcription** — SiliconFlow, compatible transcription APIs, or **Doubao Voice standard 2.0 / flash** (SiliconFlow default `TeleAI/TeleSpeechASR`; switch to the free `FunAudioLLM/SenseVoiceSmall` tier if you prefer).
- 🤖 **AI summarization** — DeepSeek (default `deepseek-v4-flash`) generates a structured note with a summary and an extracted to-do list.
- 💭 **Memo & Reminder modes** — the AI classifies each recording as a reminder, a memo, or both, and corrects speech-recognition errors automatically.
- 📱 **Mobile support** — a draggable floating record button on iOS/Android, which you can hide in settings.
- 📂 **Organized output** — every recording becomes its own file, filed by month and day (see below).
- 🍎 **Apple Reminders sync** — a clean to-do list is copied to your clipboard for iOS Shortcuts.
- 🌐 **China-friendly** — no Google APIs, no VPN. Both default services are domestic.
- 💾 **Audio kept by default** — original recordings are preserved after processing (can be auto-deleted in settings).

### 🆚 Why Audio Inbox?

| | Audio Inbox | Typical voice plugins |
|---|---|---|
| 🇨🇳 **No VPN needed** | ✅ SiliconFlow + DeepSeek | ❌ OpenAI / Google |
| 💰 **Free STT option** | ✅ SenseVoiceSmall free tier | ❌ Paid API only |
| 📱 **Mobile recording** | ✅ Draggable floating button | ❌ Command palette only |
| 🍎 **Reminders sync** | ✅ iOS Shortcuts | ❌ Not supported |
| 💭 **Memo mode** | ✅ AI distinguishes reminders vs memos | ❌ Todos only |

---

## 🔄 How it works

```
🎤 Record  →  🎧 Transcribe (STT)  →  🤖 AI summary  →  📝 Markdown note
```

Each recording is saved as an independent file:

```
VoiceNotes/
  2026-09/                 ← month
    2026-09-23/            ← day
      备忘-练车准备.md      ← memo  (one file per recording)
      待办-买书.md          ← todo
```

- File names use a short AI-generated title (e.g. `备忘-练车准备.md`, `待办-买书.md`).
- Same-day, same-title collisions get a time suffix (`备忘-练车-1840.md`).

---

## 🚀 Quick start

### 1. Get two API keys (both China-friendly, no VPN)

1. **Speech-recognition credentials** — [SiliconFlow](https://cloud.siliconflow.cn/), a compatible service, or Doubao Voice (see the requirements below). Availability, trial quotas and fees depend on the provider and your account.
2. **DeepSeek API key** — for AI summarization → https://platform.deepseek.com/

### 2. Install

**Option A — Community plugins (recommended)**
Obsidian → Settings → Community plugins → Browse → search **"Audio Inbox"** → Install → Enable.

**Option B — Manual**
Download `main.js`, `manifest.json`, and `styles.css` from the [latest Release](https://github.com/andsea007/obsidian-audio-inbox/releases), place them in `<vault>/.obsidian/plugins/audio-inbox/`, then enable the plugin in Settings → Community plugins.

### 3. Configure

Open **Settings → Audio Inbox**, select the speech-recognition service, and enter its credentials. Configure the AI summarization service separately. The compatible-service defaults are:

- STT model: `TeleAI/TeleSpeechASR` (or `FunAudioLLM/SenseVoiceSmall` for the free tier)
- Summary model: `deepseek-v4-flash`

### 4. Record

- **Desktop**: click the mic icon in the left ribbon
- **Mobile**: tap the floating button (drag to reposition)
- **Command palette**: `Ctrl/Cmd + P` → "开始语音笔记（录音）"

> ⏱️ For best accuracy, keep recordings reasonable in length. Long recordings are supported but consume more API quota.

---

### 豆包语音：开通条件与配置要求

豆包在本插件中负责**语音转文字（ASR）**。AI 总结仍使用你单独配置的、兼容 Chat Completions 的服务，需另外填写该服务的地址、模型和 Key。

| 插件识别模式 | 火山引擎需开通的服务 | 资源 ID | 适用情况 |
|---|---|---|---|
| **标准版 2.0（推荐）** | 豆包录音文件识别模型 2.0 | `volc.seedasr.auc` | 录音完成后提交，等待查询结果；控制台没有极速版选项时选此项 |
| 极速版 | 录音文件极速版识别 | `volc.bigasr.auc_turbo` | 仅限账号已获得此资源调用权限时选择 |

**使用前需满足：**

- 火山引擎账号已开通所选的**录音文件识别服务**，并有可用额度或余额。服务商可能收费；插件免费不等于豆包 API 免费，实际计费、试用额度和开通要求以控制台为准。
- 凭证与服务属于**同一个项目**；旧版控制台须属于同一个应用。新版使用豆包语音 **API Key**，旧版使用 **APP ID + Access Token**，两种鉴权方式择一。
- 豆包聊天会员、火山方舟聊天模型 Key、流式语音识别、语音合成或声音复刻权限，均不能替代上述录音文件识别权限。
- Obsidian 能联网访问语音服务；直接录音需授予麦克风权限。手机录音时保持应用在前台，锁屏或切到后台可能中断。

**配置步骤：**

1. 打开火山引擎「豆包语音」控制台，选择已开通服务的项目，获取对应语音凭证。
2. Obsidian → 设置 → Audio Inbox → 语音识别服务，选择 **豆包语音**。
3. 将「豆包识别模式」设为 **标准版 2.0**（或已获授权的极速版）。
4. 新版控制台选择「API Key」，仅粘贴 Key 值；旧版选择「APP ID + Access Token」，分别粘贴两项值。**不要粘贴整段 curl、引号、Header 名称或示例代码。**接口地址、资源 ID 和模型由插件按模式自动设置。
5. 保持 AI 总结配置完整，先录制 5～10 秒测试语音，再处理较长录音。

**文件、等待与数据说明：**

- 支持 WAV、MP3、OGG Opus；WebM/MP4 等录音会尝试转换为 16 kHz 单声道 WAV。源文件及转换后的文件均不得超过 **100 MB**。转换会增加内存占用与文件大小，长录音建议分段；60 分钟的录音设置不代表每家接口都能处理 60 分钟。
- 标准版提交任务后，每 2 秒查询一次，最多查询 150 次，并在约 5 分钟后停止继续查询（单次网络请求耗时可能使实际等待更长）。超时或失败保留原音频。重新处理会提交新任务，可能再次计费；插件不会自动恢复先前任务。
- 录音直接发送至火山引擎语音接口，无需网盘公开链接；识别文字随后发送至你配置的 AI 总结服务。凭证保存在知识库的插件配置文件中；如同步知识库，请自行管理该配置文件的同步范围。不要在公开截图或 issue 中包含凭证。
- 新配置默认推荐标准版；此前测试版已选择豆包的配置保留极速版选择，可手动切换。原兼容接口和豆包凭证分别保存。
- 标准版 Base64 上传已通过真实中文合成语音测试。官方标准版文档主要列出 URL 输入，Base64 属于实测可用行为；不承诺服务端未来保持此未明确文档化的输入方式。极速版及旧版凭证已通过模拟测试，尚未完成本次真实账号验证。

**错误排查：** 401 / Invalid X-Api-Key：检查语音凭证和鉴权方式；403 / requested resource not granted：检查同一项目是否开通所选资源。仅开通标准版时切换到标准版 2.0，无需继续寻找极速版。额度不足请检查账单；排队超时先等待再考虑重试。报告问题时可提供错误码和日志 ID，隐藏凭证及私密转写内容。

官方参考：[标准版 API](https://docs.volcengine.com/docs/DoubaoVoice/LargemodelrecordingfilerecognitionstandardversionAPI?lang=zh)、[极速版 API](https://docs.volcengine.com/docs/DoubaoVoice/LargemodelrecordingfileLiterecognitionAPI?lang=zh)、[API Key 使用](https://docs.volcengine.com/docs/DoubaoVoice/APIKeyUsage?lang=zh)。

## ⚙️ Settings

| Setting | Default | Description |
|---|---|---|
| STT API Key | — | SiliconFlow API key |
| STT API URL | `https://api.siliconflow.cn/v1/audio/transcriptions` | Speech-to-text endpoint |
| STT Model | `TeleAI/TeleSpeechASR` | Speech recognition model |
| Language | `zh` | `zh` / `en` / … |
| Summary API Key | — | DeepSeek API key |
| Summary API URL | `https://api.deepseek.com/v1/chat/completions` | Summary endpoint |
| Summary Model | `deepseek-v4-flash` | Summary model |
| Summary Prompt | *(built-in)* | Customizable AI instructions |
| Recording folder | `录音` | Where audio is saved |
| Output folder | `VoiceNotes` | Where notes are saved |
| Show transcript | `false` | Include the raw transcript in the note |
| Delete audio after processing | `false` | Auto-delete the recording once processed |
| Max recording length | `60` (min) | Recording limit |
| Auto-stop at limit | `true` | Stop automatically when the limit is reached |
| Show floating button | `true` | Mobile-only floating record button |

---

## 🍎 iOS Shortcuts (Apple Reminders sync)

After each recording, the plugin copies a clean to-do list to the clipboard. Create a Shortcut to import them:

| Step | Action | Setting |
|---|---|---|
| 1 | Get Clipboard | — |
| 2 | Split Text | By New Lines |
| 3 | Repeat with Each | — |
| ↳ | Add New Reminder | Title = Repeat Item |
| 4 | Show Notification | "✅ Synced" |

---

## ❓ Troubleshooting

- **Nothing recognized / empty note** — check that your API key is correct and that the recording contains speech. Open the developer console (`Ctrl+Shift+I`) to see logs.
- **"Model Not Exist"** — make sure the summary model is `deepseek-v4-flash` (DeepSeek retired `deepseek-chat` / `deepseek-reasoner` on 2026-07-24).
- **Balance / quota errors** — top up your SiliconFlow or DeepSeek account.
- **Microphone unavailable** — grant Obsidian microphone permission, or record with Obsidian's built-in recorder and run "处理录音文件夹" (Process recording folder) from the command palette.

---

## 🔧 Development

```bash
git clone https://github.com/andsea007/obsidian-audio-inbox.git
cd obsidian-audio-inbox
npm install
npm run dev      # watch mode
npm run build    # production build → main.js
```

---

## 📄 License

[MIT](LICENSE)

<p align="center">Made with ❤️ by <a href="https://github.com/andsea007">Andsea</a></p>
