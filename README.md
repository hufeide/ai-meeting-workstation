# AI Meeting Workstation

本地优先的 AI 会议转写与协作工作台，基于 `dingshuxin353/ai-discussion` 的 MIT 快照二次开发。原 MIT `LICENSE` 保留，上游来源、第三方组件与数据边界见 `NOTICE.md`。

> 演示模式中的“澄远科技”、参会人、会议背景及预置音频均为虚构示例，用于展示操作流程，不是真实客户案例，也不代表转写或说话人识别的准确率承诺。演示数据与使用者的正常会议资料分开保存。

## 产品能力

- 双入口首页：已有录音直接进入“上传录音转写”，现场交流进入“实时会议助手”，不再要求文件转写先手动创建会议。
- 文件转写：先选择文件并确认火山文件识别 2.0 或本地 FunASR，选择阶段不会上传；点击“开始转写”后才自动创建内部 discussion 并调用原有上传接口。失败保留文件供重试，结果页直接提供逐字稿、说话人校正和 Markdown/讨论包导出。
- 会议准备：客户档案、参与人、ASR、AI 大脑、模型都可在界面里选择。
- 开会：保留原有 websocket 实时转写链路；火山默认 Resource-Id 为 `volc.seedasr.sauc.duration`。
- 紧急文件转写：选择“火山录音文件识别（云端）”，上传本地录音后，系统使用正式标准版 `volc.seedasr.auc` 的 submit/query 接口轮询结果，并写回同一会议时间线。
- 本地隐私档：上传录音文件可走本机 FunASR，结果写回同一条会议时间线。
- AI 参谋：大脑可切换 DeepSeek、Claude CLI、Codex CLI、OpenAI 预留、Qwen 预留、Mock。
- 实时会议中可点击“由 AI 发言”，或在实时转写开启时说“AI，你怎么看这个方案？”来邀请 AI；工作台会把口头问题作为本轮引导，回复仍显示在工作台内。上传录音不会触发语音邀请。
- 商用记忆：客户档案 + 最近 N 条滚动记忆会自动拼进 AI 提示词；会后记忆必须先起草、再人工确认入库。
- 质量反馈：每次 AI 发言可标记“有用/有增量”或“蠢话/没用”，只落本地 session。

## 安装（macOS）

从 GitHub 下载**本目录对应的仓库**并解压。不要下载外层私人项目文件夹。首次安装按顺序：

1. 双击 `安装.command`（macOS 首次拦截时，在 Finder 右键选择“打开”）。选择“本地转写”或“仅云端”。
2. 安装器检查 Node.js 22+；未安装时会给出 [Node.js 下载地址](https://nodejs.org/)，安装后重新双击。
3. 本地路线检查 ffmpeg；缺少时仅在你输入 `y` 后执行 `brew install ffmpeg`。如果没有 Homebrew，先自行从 [brew.sh](https://brew.sh/) 安装。安装器不会自动安装 Homebrew。云端路线跳过此步。
4. 本地路线检查 Python 3.11–3.13；未安装时按提示安装 Python 3.13。安装器随后在本目录创建 `.venv/`：macOS 14+ Apple Silicon + Python 3.13 使用已实测的 81 包完整锁定文件 `requirements-macos-arm64-py313.lock.txt`，其他组合使用 `requirements.txt` 中固定的直接依赖（尚未做全平台实测）。然后下载 5 个模型到 `.modelscope_cache/`。云端路线跳过这些步骤。
5. 两条路线都执行 `npm ci` 安装锁定的 Node 依赖。等窗口显示“安装完成”后，双击 `启动会议纪要.command`。
6. 本地文件转写：页面选“本地 FunASR”，不需要火山或 DeepSeek Key。云端转写：在页面设置填自己的火山 ASR Key；需要 AI 参谋时再填自己的 DeepSeek Key。Key 也可写在本机 `.env` 的 `VOLCENGINE_ASR_API_KEY` / `DEEPSEEK_API_KEY`，但不要提交该文件。页面设置会保存在本机 `.local-data/`。

重复运行安装器时，已安装且版本未变的依赖、已完整下载的模型会跳过。模型下载中断可重新运行。首次下载通常需要数 GB 空间和稳定网络；具体耗时取决于网络与机器，不能保证固定分钟数。当前从零验收只覆盖 macOS 26.6.1 / Apple Silicon / Python 3.13；旧版 macOS、Intel Mac 和其他 Python 小版本仍需单独验收。

纯云端 + DeepSeek 的最小路径只需要 Node.js、npm 和项目的 Node 依赖；不需要 Python、FunASR 模型或 ffmpeg。但云端转写会把录音发送到火山，邀请 DeepSeek 发言会把相关文本发送到 DeepSeek。两项服务都需要用户自己的 Key，且可能计费。未填写任何 Key 仍可用本地文件转写；不会自动调用云端 AI。

## 一键启动

安装成功后双击 `启动会议纪要.command`，它会检查 5173/8787 端口、启动服务并打开浏览器。若仅用云端，`npm run doctor` 对缺少本地 FunASR、Codex CLI 的提示是可选功能警告，不是安装失败。

本地敏感数据写在 `.local-data/` 和 `.env`，都已被 `.gitignore` 排除。公开版默认 AI 大脑是 DeepSeek；Claude/Codex CLI 不会自动启用，只适用于使用者主动选择并使用自己的本地订阅。分发版本不得携带开发者 token。

## 客户现场演示模式

首页右上角点击“进入演示模式”即可载入虚构企业“澄远科技”的公司档案、会议背景和三位参会人。演示模式有持续可见的琥珀色边框、状态条和“演示模式 · 数据隔离”标识。

- 演示会议数据库：`.local-data/demo/app.db`
- 演示客户与记忆：`.local-data/demo/customers/`
- 演示录音与转写：`.local-data/demo/discussions/`
- 正常会议继续使用原有 `.local-data/app.db`、`.local-data/customers/` 和 `.local-data/discussions/`

如果现场麦克风或火山网络不可用，先开始一条演示会议，再点击“使用兜底录音”。系统会把预置的开源模型合成虚构会议音频送入本地 FunASR 文件转写链路，不注入预写转写结果；音频本身不发送给云端。若随后邀请云端 AI 发言，转写文本会按当前大脑配置发送给对应服务。演示结束后点击“重置演示数据”，只清理演示数据库、演示客户记忆和演示录音，不会删除正常会议数据。

公开版默认兜底文件为 `assets/demo/chengyuan-tech-fallback-open-kokoro.wav`（67.725 秒，虚构脚本，来源与许可见 `assets/demo/PROVENANCE.md`）。真人录音 `assets/demo/chengyuan-tech-fallback.wav` 和旧 Apple 系统语音文件只用于本地测试，均被 `.gitignore` 排除。

---

# Upstream ai-discussion

AI Discussion 是一个本地优先的讨论工作台 MVP：两位参与人进行深度讨论，系统实时转写、区分说话人，并允许手动邀请 Codex 作为第三位讨论者给出观点。

## 目录结构

- `src/`：前后端应用代码。
- `.local-data/`：本地运行时数据，包含 SQLite 数据库和录音文件，不提交到 Git。

## 手动开发运行

```bash
npm ci
# 可选：按 .env.example 自行创建本机 .env，不要把真实 Key 写入 .env.example
npm run doctor
npm run dev
```

本地 FunASR 录音文件处理默认最长等待 6 小时，用于支持数小时会议录音。如需调整，在 `.env` 中设置:

```text
FUNASR_FILE_TIMEOUT_MS=21600000
FUNASR_DEVICE=auto
FUNASR_PYTHON_PATH=python3
FUNASR_HOME=.
FUNASR_HOTWORD_FILE=config/hotwords/active.txt
```

该值是“转写计算可运行的最长时间”，不是限制录音时长。不建议完全取消超时，否则异常卡死的模型进程可能永久占用资源。

安装器默认把 `.venv/` 与 `.modelscope_cache/` 放在本仓库根目录，应用会优先使用它们；旧版外层目录的缓存仅作兼容。`FUNASR_PYTHON_PATH` 可以是 PATH 中的 Python 命令，也可以是虚拟环境解释器的绝对路径；留空时优先使用本目录 `.venv/bin/python`。`FUNASR_HOME` 指向包含 `.modelscope_cache` 的目录。`FUNASR_DEVICE=auto` 会在 Apple Silicon Mac 上优先使用 MPS，其他环境自动回退 CPU。

FunASR 会在每次文件转写时读取 `FUNASR_HOTWORD_FILE`。默认词表位于 `config/hotwords/active.txt`，其中只有可公开的通用示例。可以直接修改它：每行一个词，保存为 UTF-8 后重新转写；也可新建另一份词表并把环境变量指向它，无需修改代码。不要把客户隐私词表提交到 Git。格式见 `config/hotwords/README.md`。

默认地址：

- 前端：`http://127.0.0.1:5173`
- 后端：`http://127.0.0.1:8787`

## 常用命令

```bash
npm run doctor
npm run typecheck
npm run lint
npm test
npm run build
```

## 配置

后端启动时会自动读取本目录的 `.env`（可不创建）。新安装默认 AI 大脑是 DeepSeek，只有点击按钮或在实时转写中说出明确的 AI 邀请语才调用；没有 Key 会提示配置，不会偷偷切换到 Mock。Claude/Codex CLI 是可选后端，只有在页面主动选中且本机有相应 CLI 和用户自己的订阅时才使用。没有火山凭证时，火山实时转写会返回配置错误；本地 FunASR 文件转写仍可使用。

Codex CLI：

```text
CODEX_PROVIDER=cli
CODEX_CLI_PATH=codex
CODEX_CLI_TIMEOUT_MS=120000
CODEX_MODEL=
```

后端会通过 `codex exec --json` 创建会话，并通过 `codex exec resume <thread_id>` 续接同一会话。结束讨论后，页面会展示 `codex resume -C <项目目录> <thread_id>` 供人工继续该会话。

火山 ASR：

```text
VOLCENGINE_ASR_API_KEY=
VOLCENGINE_ASR_RESOURCE_ID=
VOLCENGINE_ASR_ENDPOINT=wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async
```

流式 Resource-Id 只供实时 WebSocket 使用。录音文件识别 2.0 固定使用 `volc.seedasr.auc`，两者不会互相覆盖。火山标准版官方文档限制为音频小于 5 小时、512MB；当前工作台为了同步内存上传安全，另设 200MB 产品限制。2026-08-12 已真实跑通 MP3 分段和完整原始 M4A 的 Base64 直传。46 分钟双人录音被火山自动分成 4 组说话人，因此页面保留 4 组供人工绑定，不能自动假定分组就是真实人数。上传和识别期间页面会锁定文件入口并显示等待状态，避免重复提交与重复计费。

没有火山凭证时，真实 ASR 模式不会崩溃，会在产品事件中返回 `auth_failed`。

## 本地数据清理

清理讨论数据库和录音文件：

```bash
rm -rf .local-data
```

`.local-data/` 已在 `.gitignore` 中，不应提交真实录音、数据库或 `.env`。

## 导出与删除

结束讨论后可在归档页导出 Markdown 复盘文档、导出讨论包、删除音频或删除整条讨论。导出包包含结构化讨论数据和可阅读转写，不包含 `.env` 或第三方 secret；默认不导出 raw ASR vendor event。

## 贡献与质量门禁

提交 PR 前建议运行：

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

PR 与 issue 模板位于 `.github/`。

## 许可证

本项目使用 MIT License，详见 `LICENSE`。
