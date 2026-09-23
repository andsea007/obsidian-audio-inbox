# Changelog

All notable changes to Audio Inbox are documented here.

## [2.7.3] - 2026-09-23

### Long recordings & reliability
- Raise the default recording limit to **60 minutes**, with a configurable limit and an auto-stop option.
- Keep recordings compressed as WebM/Opus and upload them without expanding hour-long audio into oversized WAV files.
- Flush the recorder's final audio event on stop or window close; detect unexpected recorder interruption and save the partial audio for recovery.
- Handle microphone-permission and recorder-startup failures without leaving the recording workflow stuck.

### Flexible speech & summary APIs
- Make the speech-recognition endpoint/model and the summary endpoint/model configurable; the plugin does not require OpenAI.
- Default speech recognition to `TeleAI/TeleSpeechASR`; default summarization to **`deepseek-v4-flash`**.
- Automatically migrate the retired `deepseek-chat` model ID to `deepseek-v4-flash` (DeepSeek retired `deepseek-chat` / `deepseek-reasoner` on 2026-07-24).
- Parse both JSON `{ "text": "..." }` and plain-text STT responses. Empty, malformed, HTML, or truncated responses now fail clearly and retain the audio.
- Reduce DeepSeek reasoning effort and increase the output allowance for long transcripts; use stricter summary instructions to limit invented facts and false todos.

### Floating button & data safety
- Add a settings switch to show or hide the mobile floating record button.
- Default to keeping original recordings after processing.
- Avoid marking an empty or unsaved AI response as successful.

## Earlier versions

See [GitHub Releases](https://github.com/andsea007/obsidian-audio-inbox/releases) for the full history (2.0.0 → 2.7.3).
