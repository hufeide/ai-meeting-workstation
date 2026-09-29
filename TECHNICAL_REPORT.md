# AI Meeting Workstation 技术报告（详细版）

> 覆盖范围：`src/client`（React 前端）、`src/server`（Express + WebSocket 后端）、`src/shared`（前后端契约）。
> 目标：按「功能」梳理从 UI 操作 → 前端函数 → 网络请求 → 后端函数 → 数据库/外部服务 → 事件回流 → 前端渲染 的完整调用链。

---

## 1. 项目概述

AI Meeting Workstation 是一个**企业会议决策台**：把会议语音实时转写，并由「AI 参谋」在关键节点（被点名 / 手动邀请）生成决策建议；支持录音文件转写、说话人绑定、客户记忆沉淀、Markdown/Zip 导出。

系统分三层：

- **前端（React + TS）**：`src/client/src/app`，以 `App.tsx` 为状态中枢，把采集、编排、渲染与纯逻辑（可单测）分离。
- **后端（Express + WS + better-sqlite3）**：`src/server`，REST 处理业务请求，两个 WebSocket（`/ws` 广播业务事件、`/audio` 收麦克风 PCM）处理实时链路。
- **契约层（shared）**：`src/shared`，定义 DTO、REST 校验 Schema、WS 事件类型，前后端共用。

---

## 2. 技术栈

| 层 | 技术 |
|---|---|
| 前端框架 | React 18 + TypeScript + Vite |
| 前端测试 | Vitest |
| 后端框架 | Express 5（`express.json({limit:"1mb"})`）+ `ws`（WebSocket）|
| 数据库 | better-sqlite3（WAL 模式，文件型 SQLite）|
| 实时 ASR | 火山引擎实时语音识别（WebSocket）/ 火山文件识别（HTTP 轮询）/ 本地 FunASR（Python 子进程）/ Mock |
| AI 大脑 | 本地 Codex CLI / Claude CLI / OpenAI 兼容 API（DeepSeek、OpenAI）/ Mock |
| 校验 | Zod（`src/shared/schemas.ts`）|
| 配置 | 环境变量 + 本机 `settings.local.json`（`src/server/settings/localSettings.ts`）|

---

## 3. 目录结构

```
src/
├─ shared/                      # 前后端契约（类型/事件/校验）
│  ├─ types.ts                  # DTO：DiscussionDetailDto/UtteranceDto/AiTurnDto/...
│  ├─ events.ts                 # ProductEvent 联合类型（WS 推送事件）
│  ├─ schemas.ts                # Zod 请求校验
│  ├─ aiTurns.ts                # isUsableAiTurn 等工具
│  └─ messages.ts               # 截断等提示文案常量
├─ client/src/app/              # 前端
│  ├─ App.tsx                   # 状态中枢（唯一大文件）
│  ├─ api.ts                    # REST 客户端（fetch + 中文错误翻译）
│  ├─ voiceInvitation.ts        # 语音点名检测（核心特色）
│  ├─ discussionTimeline.ts     # 时间线合并/排序
│  ├─ singleFlight.ts           # 并发守卫
│  ├─ fileTranscriptionFlow.ts  # 文件转写状态机
│  ├─ taskMode.ts / participantForm.ts / errorPresentation.ts / codexCommand.ts
│  └─ *.test.ts                 # 各模块单测
└─ server/                      # 后端
   ├─ index.ts                  # 入口：装配依赖、挂载路由/WS
   ├─ config/                   # serverConfig / diagnostics / doctor
   ├─ db/database.ts            # SQLite 建库 + 迁移
   ├─ storage/paths.ts          # 存储路径
   ├─ settings/localSettings.ts # 本机设置
   ├─ discussions/              # repository / routes / exporters / promptPolicy
   ├─ asr/                      # asrProvider(接口) / volcengineAsr / volcengineFile / funasrFile / mockAsr / asrEventLog
   ├─ audio/                    # audioGateway / wavWriter
   ├─ codex/                    # provider(接口) / brainRegistry / codexCli / claudeCli / openAiCompatible / mockCodex
   ├─ memory/memoryStore.ts     # 客户记忆
   ├─ ws/eventHub.ts            # 业务事件广播
   └─ demo/                     # demoWorkspace / routes（演示模式隔离）
```

---

## 4. 前后端契约（shared）

### 4.1 事件类型 `src/shared/events.ts`
`/ws` 推送的 `ProductEvent` 联合类型，是所有实时更新的载体：

```
discussion.updated          { discussion }
transcript.partial          { utterance }      // 临时转写
transcript.final            { utterance }      // 定稿转写
speaker.binding.updated     { binding }
codex.turn.started          { aiTurnId }
codex.turn.completed        { aiTurn }
codex.turn.truncated        { aiTurn }          // 回答被截断
codex.turn.failed           { aiTurnId, message }
asr.status                  { status }          // idle/connecting/connected/receiving/failed/closed
asr.error                   { code, message, retryable }
audio.asset.saved           { asset }           // 录音落盘完成
codex.status                { status }
```

### 4.2 请求校验 `src/shared/schemas.ts`
后端路由入口用 `.safeParse` 校验，失败返回 `400` + Zod `flatten()` 错误（前端 `api.ts` 再翻译为中文）。
关键 Schema：`createDiscussionSchema`、`bindSpeakerSchema`、`triggerAiTurnSchema`、`aiFeedbackSchema`、`settingsUpdateSchema`、`customerProfileSchema`、`memoryDraftConfirmSchema`、`routeIdSchema`。

### 4.3 数据类型 `src/shared/types.ts`
`DiscussionDetailDto`（聚合 participants/speakerBindings/utterances/aiTurns/audioAssets）、`UtteranceDto`、`AiTurnDto`、`SpeakerBindingDto`、`AudioAssetDto`、`CustomerDetailDto` 等。

---

## 5. 后端启动与依赖装配（`src/server/index.ts`）

入口按「普通工作区 / 演示工作区」**两套镜像依赖**装配，数据完全隔离：

```
loadServerConfig()                                   // 端口/密钥/路径
ensureStoragePaths(config)                           // 计算 dataDir 等
openDatabase(storagePaths.databasePath)              // SQLite
new DiscussionRepository(db)
new EventHub()                                       // /ws 广播枢纽
new LocalSettingsStore(storagePaths)
new MemoryStore(storagePaths)
new BrainProviderRegistry(settingsStore)             // 大脑工厂
new MockAsrService(repository, eventHub)
new FunasrFileTranscriber(...)                        // 本地 FunASR
getVolcengineFileTranscriber()                        // 懒构造火山文件转写
new AudioGateway({ repository, eventHub, storagePaths, getAsrProvider })  // /audio
// —— 演示镜像 ——
demoStoragePaths = createDemoStoragePaths(storagePaths)
demoDb / demoRepository / demoMemoryStore / demoAudioGateway(socketPath:"/demo-audio")
demoWorkspace = new DemoWorkspace({...})

const app = express(); const server = createServer(app);
eventHub.attach(server); audioGateway.attach(server); demoAudioGateway.attach(server);
app.use(express.json({limit:"1mb"}));
// REST 路由
app.get("/api/health"|"/api/config"|"/api/settings"|"/api/customers*")
app.use("/api/demo", createDemoRouter({...}))
app.use("/api/demo/discussions", createDiscussionRouter({ repository: demoRepository, ... }))
app.use("/api/discussions", createDiscussionRouter({ repository, ... }))
server.listen(config.port, config.host)
```

**普通 / 演示隔离要点**：演示使用独立的 `demoDb`、`demoRepository`、`demoMemoryStore`、`demoAudioGateway`（音频 WS 路径为 `/demo-audio`），REST 挂在 `/api/demo` 前缀；`scopedApiPath(scope, path)`（`api.ts`）据此在 `/api` 与 `/api/demo` 间切换。

---

## 6. 两大 WebSocket 机制

### 6.1 `/ws`（EventHub，单向广播，服务端→浏览器）
`ws/eventHub.ts`：`attach(server)` 在 `server.on("upgrade")` 中只处理 `pathname==="/ws"`，按 `discussionId` 把客户端 `Set` 分组；`publish(discussionId, event)` 向该组所有 `OPEN` 客户端 `JSON.stringify` 发送。这是前端 `App.tsx` 中 `socket.onmessage` 的唯一来源。

### 6.2 `/audio`（AudioGateway，双向，浏览器→服务端）
`audio/audioGateway.ts`：处理 `pathname==="/audio"`（演示态 `/demo-audio`）。连接时：
1. 取 `discussionId`、`sampleRate`；校验讨论存在。
2. `mkdir` 讨论目录，建 `WavWriter`（`audio-<ts>.wav`）与 `AsrEventLogger`（`raw-asr-events.ndjson`）。
3. `getAsrProvider(discussion)` 仅在 `asrProvider==="volcengine"` 且 `mode==="real"` 时返回 `VolcengineAsrProvider`，否则凭证检查失败直接 `publish(asr.error, retryable:false)`。
4. `asrProvider.startSession({onPartial,onFinal,onError,onLog})` 打开火山 WS。
5. `socket.on("message")`：写 PCM 到 WAV，并把音频帧 `asrSession.sendAudio(chunk)`（未连上时先缓存 `pendingChunks`）。
6. `socket.on("close")`：`asrSession.close()` → `writer.close()` → `repository.createAudioAsset()` → `publish(audio.asset.saved)` + `publish(asr.status:"closed")`。

---

## 7. 功能模块详细调用链

> 约定：`F:` 前端函数（`App.tsx`/`api.ts`），`B:` 后端函数（`routes.ts` 等），`→` 表示调用。

### 7.1 应用启动 / 配置加载
```
F: App() 挂载
  F: useEffect([]) → api.getAppConfig()
     B: GET /api/config → settingsStore.load() + VolcengineAsrProvider.checkCredentials()
        → 返回 defaultProjectPath / defaultMode / asrConfigured / settings
     F: setAppSettings + setForm(回填 asrProvider/brainProvider/brainModel)
  F: useEffect([]) → loadRecentDiscussions("normal") + loadCustomers("normal")
     B: GET /api/discussions (listDiscussionSummaries) / GET /api/customers (memoryStore.listCustomers)
  F: useEffect([discussion?.id]) → 讨论存在且非文件型 → 打开 /ws
```

### 7.2 创建讨论
```
F: handleStart() → api.createDiscussion({background,customerId,projectPath,participants,asrProvider,brainProvider,brainModel,mode})
   B: POST /api/discussions (routes.ts:37)
      B: createDiscussionSchema.safeParse → 失败 400
      B: brainRegistry.getProvider(brainProvider, brainModel).createThread({discussion})   // 建 Codex/Claude 会话，拿 codexThreadId
      B: repository.createDiscussion(createInput, codexThreadId)   // INSERT discussions + participants，status=active
      B: response 201 { discussion }
   F: setDiscussion(next) → 触发 [discussion?.id] effect → 打开 /ws
   F: loadRecentDiscussions 刷新列表
```
`createThread` 各大脑实现：`CodexCliProvider` 起子进程预创建 thread 并抢先解析 threadId；`ClaudeCliProvider`/`OpenAiCompatibleProvider` 仅返回 `${label}-${slug}-${ts}` 字符串（不真正建会话）；`MockCodexProvider` 返回假 id。

### 7.3 实时会议：音频流 + ASR + 落盘
```
F: toggleAudioCapture() → startAudioCapture()
   F: navigator.mediaDevices.getUserMedia({audio}) → new AudioContext → ScriptProcessor(4096)
   F: 连接 /audio?discussionId&sampleRate=16000 WS
   F: processor.onaudioprocess → socket.send(float32ToPcm16(...))
      B: /audio socket.on("message")
         B: WavWriter.writePcm16(chunk)              // 落盘 audio-*.wav
         B: asrSession.sendAudio(chunk)             // → 火山 ASR
      火山回结果 → VolcengineAsrSession.handleMessage → onFinal/onPartial
         B: onFinal → repository.addUtterance({isFinal:true, source:"volcengine"}) → eventHub.publish(transcript.final, saved)
         B: onPartial → eventHub.publish(transcript.partial, createTransientPartialUtterance)
      F: /ws onmessage → transcript.final/final → setDiscussion(mergeUtterance) → 时间线渲染
      F: transcript.final 且 source==="volcengine" → voiceInvitationRef.onFinal(utterance)
```
`WavWriter.close()` 返回 `{path, durationMs}`（`durationMs = bytesWritten/2/sampleRate*1000`），供 `createAudioAsset` 记录。

### 7.4 语音点名邀请 AI（核心特色）
```
F: /ws transcript.final → VoiceInvitationDetector.onFinal(utterance)   // voiceInvitation.ts
   - 正则 voiceInvitationGuidance() 判断是否「点名 AI」（如「会议助手，你怎么看…」）
   - 同说话人 12s 内续说则拼接；否则清候选
   - 静音 1.8s → setTimeout → onInvite(guidance)
F: onInvite → inviteByVoiceRef.current(guidance) → inviteAi(guidance, "voice")
```
守卫：`inviteAi` 中语音来源须满足 `isRecording && active && asrProvider==="volcengine"`；`aiTurnFlightRef` 防重入。

### 7.5 手动邀请 AI / 触发 AI 回合
```
F: handleInviteCodex()（按钮 / Ctrl+Enter）→ voiceInvitation.cancelPending() → inviteAi(aiGuidance, "manual")
   F: inviteAi → api.triggerAiTurn(discussionId, guidance)
      B: POST /api/discussions/:id/ai-turns (routes.ts:181)
         B: repository.listFinalUtterancesSinceLastAiTurn(discussionId)  // 取上次 AI 之后定稿转写
         B: brainRegistry.getProvider(discussion.brainProvider, discussion.brainModel)
         B: memoryStore.buildPromptContext(customerId, recentMemoryCount)  // 拼客户记忆
         B: provider.buildPrompt({discussion, utterances, memoryContext, guidance})
            = promptPolicy.buildDiscussionTurnPrompt(...)   // 记忆 + 参谋指令 + 主持引导 + 新增对话 + 输出要求
         B: provider.respond(turnInput)                     // 调 Codex/Claude/DeepSeek
         B: repository.createCompletedAiTurn(...) → eventHub.publish(codex.turn.completed, aiTurn)
            失败: TruncatedAiResponseError → createTruncatedAiTurn + publish(codex.turn.truncated)
            其它: createFailedAiTurn + publish(codex.turn.failed)
      F: setDiscussion(mergeAiTurn)  // 立即写入「挂起」回合，completed 后再替换
   F: /ws codex.turn.completed → setDiscussion(mergeAiTurn) → 渲染 AI 回答
```

### 7.6 文件转写（上传录音）
```
F: handleChooseAudioFile() → setSelectedAudioFile
F: handleStartFileTranscription() → audioUploadFlightRef.run(...)
   - 无文件型讨论则 api.createDiscussion({asrProvider:"volcengine-file"})
   - api.uploadAudioFile({discussionId, file})   // 二进制 arrayBuffer POST，octet-stream
      B: POST /api/discussions/:id/audio-upload (routes.ts:102, raw({limit:"200mb"}))
         B: discussion.asrProvider==="volcengine-file"
              ? getVolcengineFileTranscriber().transcribeUpload({discussionId,filename,audio})
              : funasrFileTranscriber.transcribeUpload(...)   // 本地 FunASR
         B: transcribeUpload → 写 utterance(source 区分) + createAudioAsset
         B: eventHub.publish(discussion.updated)
      F: setDiscussion(result.discussion)
   F: /ws discussion.updated → refreshDiscussion → 渲染转写结果
```
- `VolcengineFileTranscriber.transcribeUpload`：校验 ≤200MB → 上传火山（base64）→ 每 1s 轮询 `queryEndpoint` 直到 `X-Api-Status-Code==20000000` → 落盘原始音频 + `volcengine-transcript.txt` → `writeUtterances`。
- `FunasrFileTranscriber.transcribeUpload`：`spawn(pythonPath, [--input,--output-dir,--asr-home,--device,--speaker-diarization, (--hotword-file)])` → 读 `transcript.txt` + `speaker_segments.json` → `writeUtterances`（source:`funasr`）。

实时会议中途补传：`handleUploadAudio()` 走同一 `uploadAudioFile` 与 SingleFlight。

### 7.7 说话人绑定
```
F: handleBindSpeaker(speakerLabel, participant) → api.bindSpeaker(...)
   B: POST /api/discussions/:id/speaker-bindings (routes.ts:79)
      B: repository.bindSpeaker(...)              // UPSERT speaker_bindings，并回填 utterances.participant_id
      B: if discussion.customerId → memoryStore.rememberSpeaker(customerId, speakerLabel, displayName)
      B: eventHub.publish(speaker.binding.updated) + publish(discussion.updated)
   F: /ws → refreshDiscussion → 更新 unboundSpeakerLabels
```

### 7.8 客户记忆沉淀
```
F: handleDraftMemory() → api.draftMemory(discussionId)
   B: POST /api/discussions/:id/memory-draft (routes.ts:274)
      B: 校验 discussion.customerId 存在（否则 400）
      B: provider.completePrompt({ prompt: memoryStore.buildMemoryDraftPrompt(discussion), cwd: projectPath })
         = buildMemoryDraftPrompt = final 转写 + buildPromptContext + 起草指导语
      B: memoryStore.createDraft({customerId, discussionId, content})
   F: setMemoryDraft + setMemoryDraftText → 展示草稿供编辑
F: handleConfirmMemory(content) → api.confirmMemory(...)
   B: POST /api/discussions/:id/memory-draft/confirm (routes.ts:306)
      B: memoryStore.confirmDraft({customerId, discussionId, content})  // 追加 rolling-memory.json/.md，draft 标 confirmed
      B: response { memory, customer: memoryStore.getCustomer(customerId) }
   F: setSelectedCustomer + loadCustomers 刷新客户档案
```
`MemoryStore` 存储结构（`customersDir/<id>/`）：`company-profile.json/.md`、`rolling-memory.json/.md`、`speaker-map.json`、`pending-memory-drafts/<discussionId>.json`。

### 7.9 AI 反馈评分
```
F: handleMarkAiFeedback(aiTurnId, rating) → api.markAiTurnFeedback(...)
   B: POST /api/discussions/:id/ai-turns/:aiTurnId/feedback (routes.ts:251)
      B: repository.markAiTurnFeedback({discussionId, aiTurnId, rating})  // UPDATE ai_turns SET feedback_rating
   F: setDiscussion(map 替换该 aiTurn)
```

### 7.10 结束 / 删除 / 删除音频
```
结束：
F: handleEndDiscussion() → stopAudioCapture() → api.endDiscussion(...)
   B: POST /api/discussions/:id/end (routes.ts:330)
      B: mockAsr.stop(discussionId) → eventHub.publish(asr.status:"idle")
      B: repository.endDiscussion(id)  // UPDATE status='ended', ended_at
      B: eventHub.publish(discussion.updated)
   F: setDiscussion(ended) + 展开 codex 接力命令

删除讨论：
F: handleDeleteDiscussion() → 确认 → api.deleteDiscussion(...)
   B: DELETE /api/discussions/:id (routes.ts:364)
      B: 删磁盘 discussionsDir/<id> → repository.deleteDiscussion(id)

删除音频（保留转写/AI）：
F: handleDeleteAudio() → api.deleteDiscussionAudio(...)
   B: DELETE /api/discussions/:id/audio (routes.ts:343)
      B: 遍历 audioAssets 路径 rmSync → repository.deleteAudioAssets(id)
```

### 7.11 导出
```
F: 导出按钮 → discussionMarkdownExportUrl / discussionPackageExportUrl（api.ts 仅返回 URL）
   B: GET /api/discussions/:id/export/markdown → renderDiscussionMarkdown(discussion)  // text/markdown 附件
   B: GET /api/discussions/:id/export/package → createDiscussionPackage(discussion, storagePaths)  // application/zip
```

### 7.12 设置 / 客户管理
```
设置保存：
F: handleSaveSettings(update) → api.saveSettings(...)
   B: PUT /api/settings (routes.ts:138) → settingsUpdateSchema.safeParse
      B: settingsStore.save(update)  // 合并+写 settings.local.json + 环境变量覆盖 → publicSettings()
客户选择/保存：
F: handleSelectCustomer / handleSaveCustomer → api.getCustomer / api.saveCustomer
   B: GET|POST /api/customers* → memoryStore.getCustomer / saveCustomer
演示：
F: handleEnterDemoMode → api.bootstrapDemoMode → B: POST /api/demo/bootstrap → demoWorkspace.bootstrap()
F: handleResetDemoMode → api.resetDemoMode → B: POST /api/demo/reset → demoWorkspace.reset()（clearAllDiscussions + resetDirectory）
F: handleLoadFallbackAudio → api.loadDemoFallbackAudio → B: POST /api/demo/discussions/:id/fallback-audio → demoWorkspace.loadFallbackAudio()（FunASR 本地处理预置 wav，去重 + 标记文件防重复）
```

### 7.13 重连 ASR
```
F: handleReconnectAsr() → stopAudioCapture() → setAsrStatus("idle") → startAudioCapture()
   // 重新走 7.3 的 /audio 连接与火山 startSession
```

---

## 8. AI 大脑 Provider 实现（`src/server/codex`）

所有 Provider 实现 `CodexProvider` 接口（`provider.ts`）：`createThread / buildPrompt / respond / completePrompt`。`buildPrompt` 统一复用 `promptPolicy.buildDiscussionTurnPrompt`。

| Provider | 通道 | `respond` 实现 |
|---|---|---|
| `MockCodexProvider` | 假数据 | 无转写返回占位；否则返回固定判断文案 |
| `CodexCliProvider` | 本地 `codex` 子进程 | `spawn` + stdin 写 prompt + 逐行 `parseCodexJsonl` 取 `finalText`；超时 SIGTERM |
| `ClaudeCliProvider` | 本地 `claude` 子进程 | `spawn(["-p","--model",...])`，close 后返回 trimmed 文本 |
| `OpenAiCompatibleProvider` | HTTP（DeepSeek/OpenAI） | `fetch POST {baseUrl}/v1/chat/completions`，`finish_reason==="length"` → 抛 `TruncatedAiResponseError`（接入截断语义）|

`brainRegistry.getProvider(provider, model)`（`brainRegistry.ts`）按 `mock/codex-cli/claude-cli/deepseek/openai/local-qwen` 返回对应实例；`local-qwen` 预留未实现（抛错）。

**截断语义**：`routes.ts` 捕获 `TruncatedAiResponseError` → `repository.createTruncatedAiTurn` + 推 `codex.turn.truncated`；前端 `errorPresentation.aiTurnSystemNotice(status==="truncated")` 显示「回答被截断」提示。

---

## 9. ASR Provider 实现（`src/server/asr`）

`AsrProvider` 接口（`asrProvider.ts`）：`checkCredentials() / startSession({onPartial,onFinal,onError})`。

| Provider | 通道 | 说明 |
|---|---|---|
| `VolcengineAsrProvider` | 火山实时 WS | `startSession`→`VolcengineAsrSession`：握手头 `X-Api-Key/Resource-Id/Connect-Id` → `sendFullClientRequest`(msgType=1) → 循环 `sendAudio`(msgType=2, gzip) → `handleMessage`(msgType=9 partial/final, 15 error) |
| `VolcengineFileTranscriber` | 火山文件 HTTP | `transcribeUpload` 上传 base64 → 每 1s 轮询 query 直到完成 |
| `FunasrFileTranscriber` | 本地 Python | `spawn` FunASR 脚本 → 读 `transcript.txt` + `speaker_segments.json` |
| `MockAsrService` | 定时器 | `start` 每 1.8s 生成 partial→450ms 后 final，推 `transcript.*` + `asr.status` |

**Provider 选择**：实时麦克风档由 `AudioGateway.getAsrProvider` 注入（仅 `volcengine` 返回 provider）；文件档在 `audio-upload` 路由按 `discussion.asrProvider` 选火山文件或 FunASR。`asrEventLog.ts` 记录火山实时全链路帧（NDJSON）。

---

## 10. 数据模型（`src/server/db/database.ts`）

better-sqlite3，WAL 模式，外键级联删除。表：

| 表 | 关键字段 |
|---|---|
| `discussions` | id, title, topic, background, project_path, mode, customer_id, asr_provider, brain_provider, brain_model, codex_thread_id, status, created_at, started_at, ended_at |
| `participants` | id, discussion_id, display_name, role, sort_order |
| `speaker_bindings` | id, discussion_id, speaker_label(UNIQUE), participant_id, created/updated_at |
| `utterances` | id, discussion_id, speaker_label, participant_id, text, start_ms, end_ms, is_final, source, raw_event_json, created_at |
| `ai_turns` | id, discussion_id, ai_turn_type, codex_thread_id, trigger_start/end_utterance_id, prompt, response, status, error_message, feedback_rating, created/completed_at |
| `audio_assets` | id, discussion_id, path, format, duration_ms, source, created_at |

`DiscussionRepository`（`repository.ts`）为唯一 DB 访问层，所有读写经此处；`listFinalUtterancesSinceLastAiTurn` 用最近一次 completed/truncated AI 回合的 `trigger_end_utterance_id` 之后、`is_final=1` 的转写。

---

## 11. 存储与文件

- **SQLite**：结构化数据（`dataDir/*.db`，演示 `dataDir/demo/*.db`）。
- **讨论音频/日志**：`discussionsDir/<id>/audio-<ts>.wav`（浏览器原始 PCM 落盘）、`raw-asr-events.ndjson`（火山实时帧日志）。
- **客户记忆**：`customersDir/<id>/`（profile / rolling-memory / speaker-map / pending-memory-drafts）。
- **设置**：`dataDir/settings.local.json`（`LocalSettingsStore`）。
- **演示隔离**：`createDemoStoragePaths` 指向 `dataDir/demo`，独立 db/memory/repository/audioGateway，根目录名校验防越界（`assertDemoRoot`/`resetDirectory`）。

---

## 12. 前端辅助模块（`src/client/src/app`）

均为无副作用纯函数 + Vitest 单测，被 `App.tsx` 组合：

| 模块 | 作用 |
|---|---|
| `api.ts` | REST 客户端；`requestJson` 统一错误 → `formatApiError`（Zod flatten 翻译为中文，如「请填写讨论背景」）；`scopedApiPath` 区分 `/api` 与 `/api/demo` |
| `voiceInvitation.ts` | 点名检测：`VoiceInvitationDetector`（partial/final/续说拼接/1.8s 静音触发）+ `voiceInvitationGuidance` 正则 |
| `discussionTimeline.ts` | `mergeUtterance/mergeAiTurn` 增量更新 + `buildVisibleDiscussionTimeline` 排序 + `unboundSpeakerLabels` |
| `singleFlight.ts` | `SingleFlight` 并发守卫（防重复上传/AI 触发）|
| `fileTranscriptionFlow.ts` | 文件转写状态机 `runFileTranscription`（配合 SingleFlight）|
| `taskMode.ts` | `home/file/live` 模式判定、文件名/大小解析、已知说话人解析 |
| `participantForm.ts` | 参与人表单增删改（默认 ≥2 人）|
| `errorPresentation.ts` | 底层错误 → 用户友好文案；`aiTurnDisplayText` 拼接截断提示 |
| `codexCommand.ts` | `codexResumeCommand` 生成并 shell 安全转义 `codex resume` 命令 |

---

## 13. 测试

- 前端：`*.test.ts`（Vitest）：`voiceInvitation`、`fileTranscriptionFlow`、`discussionTimeline`、`singleFlight`、`taskMode`、`participantForm`、`errorPresentation`、`codexCommand`、`speakerLetter`。
- 后端：`asr/volcengineAsr.test.ts`、`asr/volcengineFile.test.ts`、`audio/audioGateway.test.ts`、`codex/*.test.ts`、`discussions/repository.test.ts`、`discussions/routes.test.ts`、`discussions/promptPolicy.test.ts`、`config/*.test.ts`、`demo/demoWorkspace.test.ts`、`settings/localSettings.test.ts`。

---

## 14. 附录：端到端调用总览（实时会议 + 语音点名）

```
浏览器 App.tsx                  网络                    server
─────────────                  ──────                 ──────
handleStart → POST /discussions
                                → routes.createDiscussion
                                    ├─ brainRegistry.getProvider().createThread
                                    └─ repository.createDiscussion → 201
setDiscussion → 打开 /ws ◀────── eventHub（按 discussionId 分组）
toggleAudioCapture → /audio WS ─▶ AudioGateway
                                    ├─ WavWriter 落盘 .wav
                                    └─ VolcengineAsrProvider.startSession
                                                    │ 实时识别
                                ◀ transcript.final ─ eventHub ─▶ /ws ─▶ mergeUtterance
VoiceInvitationDetector.onFinal ─▶ inviteAi("voice")
                                → POST /ai-turns ─▶ provider.respond
                                    └─ repository.createCompletedAiTurn
                                ◀ codex.turn.completed ─ /ws ─▶ mergeAiTurn（渲染）
```

---

*报告基于源码静态分析生成，覆盖主要功能路径；具体行号以各文件当前版本为准。*
