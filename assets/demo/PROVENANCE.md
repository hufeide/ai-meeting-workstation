# 公开演示音频来源

- 文件：`chengyuan-tech-fallback-open-kokoro.wav`，67.725 秒，24 kHz、单声道 PCM WAV，SHA-256：`9c7fcb4b2e501714ddc8af8f16af3a1f098679b40fc3446552217878d580c10d`。
- 内容：为虚构公司“澄远科技”原创编写的十句中文项目复盘对话；不含真实客户、录音或会议资料。
- 生成：2026-09-23 在本机使用 `hexgrad/Kokoro-82M` v1.0 模型、`kokoro` Python 包 0.7.4、中文声线 `zf_xiaobei` 与 `zm_yunjian`；只发布生成的音频，不发布模型权重或工具依赖。
- 授权依据：[Kokoro-82M 模型卡](https://huggingface.co/hexgrad/Kokoro-82M)标注 Apache-2.0，[声线表](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md)列出上述中文声线。脚本文字为本项目原创。模型卡称权重可用于商业部署；本文件不构成法律意见，正式商业再分发仍应复核当时的模型卡、训练数据说明与适用条款。
- 验证：本地 FunASR 对该音频生成非空转写和说话人分段；声线聚类可能把两个人分错，不能宣传为身份识别准确率已验收。

本目录中的 `chengyuan-tech-fallback.wav` 是本机授权测试的真人音频，`chengyuan-tech-fallback.system-tts-backup-2026-08-04.wav` 是 Apple 系统语音旧版；两者都不属于公开发布物。
