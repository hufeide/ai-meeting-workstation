# AI Meeting Workstation NOTICE

This project is based on a local snapshot of [dingshuxin353/ai-discussion](https://github.com/dingshuxin353/ai-discussion), licensed under MIT. The upstream `LICENSE` file and copyright notice are preserved in this working copy.

## Third-party / Provider Notes

- ai-discussion snapshot: MIT License, copyright retained from upstream contributors.
- React / Vite / Express / SQLite-related npm dependencies: see `package.json` and `package-lock.json` for package names and versions.
- Volcengine ASR: optional cloud ASR provider. Default Resource-Id is `volc.seedasr.sauc.duration` for the cheaper Doubao streaming speech recognition 2.0 duration tier. Customers must use their own Volcengine account and key.
- Local FunASR: optional local upload-file transcription path. The installer downloads five ModelScope `iic` models separately into the user's ignored cache; model weights are not included in the source release. Their downloaded model cards each state Apache License 2.0. Users should review the current cards and terms before commercial redistribution of model weights.
- FFmpeg: used as an external executable for local audio conversion; no FFmpeg binary is included in this source release. The optional Homebrew formula currently identifies itself as GPL-3.0-or-later. Installing it separately avoids redistributing its binary in this repository, but does not erase the need to observe its license when distributing a packaged binary later.
- DeepSeek: customer-default cloud brain provider, OpenAI-compatible API, default model configured as `deepseek-v4-pro`. Customers must use their own DeepSeek key.
- Claude CLI / Codex CLI: local CLI brain providers for users running their own local subscription. Developer tokens or subscription state must never be embedded, exported, packaged, or distributed.
- Demo fallback audio: the public sample is generated from an original fictional script with Apache-2.0-licensed Kokoro-82M Chinese voices. See `assets/demo/PROVENANCE.md`. The local human recording and old Apple system-voice recording are excluded from version control and distribution.
- OpenAI GPT and local Qwen: interface positions are reserved in this version; local Qwen is not implemented in this round.

## Data Boundary

Local customer profile, rolling memory, memory drafts, API keys, uploaded audio, ASR outputs, and SQLite data are stored under `.local-data/`, which is ignored by git. Cloud providers receive meeting content only when the user explicitly selects a cloud ASR or cloud brain provider and supplies the relevant account key.
