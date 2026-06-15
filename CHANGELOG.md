# Changelog

All notable changes to Audio Inbox will be documented in this file.

## [2.0.0] - 2026-06-15

### 🎉 Initial Public Release

#### Core Features
- 🎙️ **One-click Recording** — Click the mic icon → speak → stop → done
- 🧠 **Smart Transcription** — SiliconFlow SenseVoiceSmall STT (free tier, China-friendly)
- 🤖 **AI Summarization** — DeepSeek generates structured notes with summary & to-do list
- 📱 **Mobile Support** — Draggable floating action button, works on iOS/Android
- ✅ **Todo Extraction** — Auto-extracts `- [ ]` items into a dedicated todo file
- 🍎 **Apple Reminders Sync** — Exports clean todo list for iOS Shortcuts integration
- 📂 **Batch Processing** — Process pre-recorded audio files in inbox folder
- 🌐 **China-Friendly** — No Google APIs, no VPN required

#### Technical Highlights
- WAV auto-conversion for STT compatibility (browser MediaRecorder outputs webm/ogg, SiliconFlow requires WAV)
- CORS-free API calls via Obsidian `requestUrl` (not `fetch`)
- Hand-built multipart/form-data for STT upload (Obsidian API limitation)
- Draggable FAB with proper touch event delegation (doesn't block page interaction)
- iCloud Shortcuts folder sync for cross-platform todo workflow

#### Commands
| Command | Description |
|---|---|
| `开始语音笔记（录音）` | Start/stop recording |
| `处理录音文件夹` | Batch process audio files |
| `标记已同步的待办为完成` | Mark exported todos as done in Obsidian |

#### Bug Fixes (during development)
- Fixed STT returning "未识别到文本" — webm format unsupported, added WAV conversion
- Fixed CORS errors — switched from `fetch` to `requestUrl`
- Fixed mobile FAB capturing all touch events — proper event delegation pattern
- Fixed duplicate todos in Apple Reminders — `待办-clean.txt` now overwrites instead of appends
- Fixed cached `data.json` overriding new default prompt — added auto-migration

---

## [1.0.0] - 2026-06-14 (Internal)

- Initial prototype with basic recording and STT
- Web Speech API (abandoned — blocked in China)
