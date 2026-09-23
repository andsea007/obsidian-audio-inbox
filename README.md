# 🎤 Audio Inbox

> **One-click voice recording → speech-to-text → AI summary**, saved as Markdown inside your vault.
> Desktop & mobile · China-friendly (no VPN needed) · Free STT tier available

[![Obsidian Downloads](https://img.shields.io/badge/dynamic/json?logo=obsidian&query=%24%5B%22audio-inbox%22%5D.downloads&url=https://raw.githubusercontent.com/obsidianmd/obsidian-releases/community-plugins-stats.json&label=downloads)](https://obsidian.md/plugins?id=audio-inbox)
[![GitHub release](https://img.shields.io/github/v/release/andsea007/obsidian-audio-inbox)](https://github.com/andsea007/obsidian-audio-inbox/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> ⭐ If this plugin helps you, a Star is appreciated!

---

## ✨ Features

- 🎙️ **One-click recording** — tap the mic, speak, stop. No extra steps.
- ⏱️ **Long recordings** — record up to **60 minutes** by default (configurable), compressed as WebM/Opus so hour-long audio stays small.
- 🧠 **Smart transcription** — SiliconFlow speech recognition (default `TeleAI/TeleSpeechASR`; switch to the free `FunAudioLLM/SenseVoiceSmall` tier if you prefer).
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

1. **SiliconFlow API key** — for speech-to-text. Free tier available → https://cloud.siliconflow.cn/
2. **DeepSeek API key** — for AI summarization → https://platform.deepseek.com/

### 2. Install

**Option A — Community plugins (recommended)**
Obsidian → Settings → Community plugins → Browse → search **"Audio Inbox"** → Install → Enable.

**Option B — Manual**
Download `main.js`, `manifest.json`, and `styles.css` from the [latest Release](https://github.com/andsea007/obsidian-audio-inbox/releases), place them in `<vault>/.obsidian/plugins/audio-inbox/`, then enable the plugin in Settings → Community plugins.

### 3. Configure

Open **Settings → Audio Inbox** and paste both API keys. Defaults work out of the box:

- STT model: `TeleAI/TeleSpeechASR` (or `FunAudioLLM/SenseVoiceSmall` for the free tier)
- Summary model: `deepseek-v4-flash`

### 4. Record

- **Desktop**: click the mic icon in the left ribbon
- **Mobile**: tap the floating button (drag to reposition)
- **Command palette**: `Ctrl/Cmd + P` → "开始语音笔记（录音）"

> ⏱️ For best accuracy, keep recordings reasonable in length. Long recordings are supported but consume more API quota.

---

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
