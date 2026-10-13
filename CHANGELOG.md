# Changelog

All notable changes to Audio Inbox are documented here.

## [2.8.0] - 2026-10-12

新增豆包录音文件识别**标准版 2.0**与极速版选择，支持新版 API Key、旧版 APP ID + Access Token。保留 2.7.3 的长录音、悬浮按钮开关、兼容接口压缩上传和录音保留等功能。

### 使用豆包前请确认

- 推荐开通「**豆包录音文件识别模型 2.0**」，在插件中选「豆包语音 → 标准版 2.0」，资源 ID 为 `volc.seedasr.auc`。
- 极速版需要单独获得 `volc.bigasr.auc_turbo` 调用权限。控制台没有极速版选项时直接使用标准版 2.0。
- 使用同一项目的豆包语音 API Key；旧版使用同一应用的 APP ID + Access Token。只粘贴凭证值，不要粘贴 curl。聊天会员、聊天模型 Key、流式识别及语音合成权限不能代替录音文件识别权限。
- 需有效额度或余额，费用以火山引擎控制台为准。AI 总结服务另行配置；豆包在这里仅负责语音转文字。
- 音频发送至火山引擎，转写文字再发送至所配置的 AI 服务。源音频和转换后的 WAV 均限 100 MB，长录音建议分段。
- 标准版最多查询 150 次、约 5 分钟后停止继续查询，网络耗时可能延长实际等待。失败保留录音；再次处理是新任务，可能再次计费。
- 标准版 Base64 上传已用真实中文合成语音验证；官方标准版文档主要说明 URL 输入，此上传方式存在服务端兼容性变化的可能。极速版与旧版凭证本次仅完成模拟测试。

### 安装与升级

Obsidian → 设置 → 第三方插件 → 检查更新 → Audio Inbox。手动安装请下载下方 **main.js、manifest.json、styles.css** 三个文件，放入 `<知识库>/.obsidian/plugins/audio-inbox/`，然后重新加载插件。已有配置保留；已有豆包测试版配置可能仍选极速版，请按已开通服务切换。

完整说明：[README 豆包配置要求](https://github.com/andsea007/obsidian-audio-inbox#豆包语音开通条件与配置要求)。

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
