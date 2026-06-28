# Changelog

All notable changes to Audio Inbox will be documented in this file.

## [2.1.3] - 2026-06-28

### 🐛 Bug Fixes
- **手机端备忘录无法保存** — `saveMemo()` 增加完整的 try-catch 错误处理，将 vault 文件读写操作拆分为独立步骤，修复了移动端 Capacitor 环境下的异步时序问题。现在手机录音→AI分类→备忘录保存完全正常工作。

### ✨ New Features
- **处理后自动删除录音文件** — 新增设置开关「处理后删除录音文件」（默认开启）。录音转文字+AI处理完成后自动删除原始音频文件，使用 `vault.trash()` 安全删除可恢复。手机再也不用担心音频文件堆满存储空间。桌面端和手机端均生效。
- 批量处理（处理录音文件夹）也会在处理完成后自动删除。

### 🎨 UI Improvements
- **侧边栏图标**：`mic` 改为 `audio-lines`（音频波纹），更现代、不撞车
- **移动端悬浮按钮**：紫色圆形 emoji 改为红色圆形 + 白色SVG矢量图标（圆环套实心点的"瞳"设计），深色主题下辨识度极高

### 📖 Docs
- README 新增录音时长建议：控制在 5 分钟以内以获得最佳 STT 识别和 AI 总结效果

## [2.1.1] - 2026-06-18

### ✨ New Feature: Memo Mode

Audio Inbox now intelligently distinguishes between **reminders** and **memos**, saving each to a dedicated file.

#### How it works
The AI analyzes each recording and classifies it as one of:
- **📌 提醒事项 (Reminder)** — has actionable tasks → saved to `待办事项.md` (unchanged)
- **💭 备忘录 (Memo)** — records info/ideas/knowledge, no action items → saved to new `备忘录.md`
- **🔀 混合 (Mixed)** — has both → saved to both files

#### Memo file format (`备忘录.md`)
Each entry includes:
- 📝 **AI 总结** — AI-organized, cleaned-up version of the content
- 🗣️ **原话** — the original verbatim transcript from STT
- 📁 Link to the audio recording

#### Improvements
- **Smarter AI prompt** — asks the AI to classify content type and output structured sections (### 类型 / ### 总结 / ### 待办事项 / ### 备忘内容)
- **Robust parser** — `parseAIResponse()` handles both the new structured format and legacy `## 📋 总结` / `## ✅ 待办事项` formats
- **Fallback inference** — if the AI doesn't output a type, the parser infers it from content (todos present → reminder, keywords like "开会/买/记得" → reminder, otherwise → memo)
- **Better logging** — added console logs for AI response, parsed type, and flow timing to aid debugging
- **Auto-migration** — old `summaryPrompt` settings are automatically upgraded to the new prompt on load

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
