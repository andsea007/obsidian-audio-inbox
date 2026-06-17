# Changelog

All notable changes to Audio Inbox will be documented in this file.

## [2.0.5] - 2026-06-17

### 🛡️ Final Review Compliance

- **Static styles**: Use CSS class `.ai-fab-dragged` instead of `setProperty()` for `right`/`bottom` reset
- **minAppVersion**: Bump to 1.4.0 to cover `vault.createFolder()` and all other APIs in use
- **Settings heading**: Remove plugin name from settings heading (Obsidian already shows it)
- **globalThis**: Replace `typeof globalThis` with safer type cast for popout compatibility

## [2.0.4] - 2026-06-17

### 🛡️ Obsidian Community Review Compliance

Full pass to resolve all errors and warnings reported by the Obsidian community plugin automated scanner.

#### Fixed (Errors — blocked review)
- **OS detection**: Replaced `navigator.userAgent` regex with the official `Platform.isMobileApp` API
- **CSS assignment**: Replaced direct `el.style.xxx = ...` with `el.style.setProperty(...)` for FAB positioning
- **minAppVersion mismatch**: Bumped `minAppVersion` from `1.0.0` to `1.2.0` to match the APIs actually in use (`activeDocument`, `Setting.setHeading`, etc.)
- **Settings headings**: Replaced `containerEl.createEl("h3", ...)` with `new Setting(containerEl).setName(...).setHeading()` for consistent UI

#### Fixed (Warnings)
- **Popout compatibility**: `setInterval` / `clearInterval` / `setTimeout` → `window.*` variants
- **Popout compatibility**: `document` → `activeDocument` everywhere
- **TypeScript safety**: Removed all `any` types; added proper interfaces for `RequestUrlResponse`, `AudioContext`, clipboard errors, etc.
- **Promise handling**: Fire-and-forget promises now marked with `void` operator
- **Dead code**: Removed unused variables (`dot`, `e`)
- **Removed Node.js builtins**: No more `require('fs')`, `require('path')`, `require('os')`, `process.platform`
- **Removed dependency**: Dropped `builtin-modules` from `package.json`

#### Changed
- **Shortcuts sync simplified**: `saveToShortcutsFolder()` now uses the clipboard API uniformly on desktop and mobile (previously desktop wrote directly to the iCloud Shortcuts folder via Node.js `fs`). The vault file `待办-clean.txt` is still written via the Obsidian Vault API.
- **markTodosDone()**: No longer touches the filesystem outside the vault.

## [2.0.1] - 2026-06-16

### 🐛 Bug Fixes

- **Mobile `待办-clean.txt` not updating** — `saveToShortcutsFolder()` used Node.js `fs` which is unavailable on mobile (Capacitor/Cordova). Now detects platform: desktop writes to Shortcuts iCloud folder, mobile copies to clipboard with notice.
- Added console logging in `saveTodos()` for easier debugging

### 🔧 Improvements

- Platform detection: `isMobile()` helper checks both user agent and Capacitor presence
- Mobile clipboard fallback: todos copied to clipboard → Shortcut reads from clipboard instead of file
- Better error messaging: mobile users get clear instructions to run the Shortcut

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
