这份技术报告已经把 AI Meeting Workstation 的底层实现梳理得比较完整。我们可以不只看“用了哪些技术”，而是从程序怎么运行、音频怎么传输、AI 怎么被调用、数据怎么保存、各模块怎么协作这几个角度理解。

我会以你上传的技术报告为依据，结合常见的软件工程原理解释。先建立一个整体认识：

它本质上是一个 TypeScript 全栈应用，使用 Node.js 做后端运行时，Express 处理 HTTP，WebSocket 处理实时通信，SQLite 保存结构化数据，ASR 和 LLM 作为可替换的外部或本地计算服务。

其中，前端和后端不是两个独立产品，而是通过 HTTP、WebSocket 和共享类型契约组成一个完整系统。


# 一、先看底层技术栈：每项技术究竟负责什么？

依据技术报告第 2、3、5、8、9、10 节。

|
技术

|

所在层

|

实际职责

|
| --- | --- | --- |
|

React 18

|

浏览器

|

组件化界面、状态更新、用户交互

|
|

TypeScript

|

前后端

|

静态类型检查，约束数据结构和函数接口

|
|

Vite

|

前端开发工具

|

开发服务器、前端打包

|
|

Node.js

|

后端运行时

|

执行 JavaScript/TypeScript 编译后的服务端程序

|
|

Express 5

|

HTTP 服务

|

路由、中间件、REST API

|
|

`ws`

|

网络通信

|

WebSocket 长连接和实时事件、音频传输

|
|

better-sqlite3

|

数据持久化

|

通过 Node.js 访问 SQLite 数据库

|
|

Zod

|

输入校验

|

校验 HTTP 请求参数和请求体

|
|

Vitest

|

测试

|

测试前端纯逻辑及相关模块

|

来源：上传报告第 2 节技术栈及第 3 节目录结构。

粘贴的 markdown (1)。md

这里有三个特别容易混淆的概念。

## 1. TypeScript 不等于运行时

TypeScript 是 JavaScript 的类型增强语言。比如：

TypeScript

```
type DiscussionStatus = "active" | "ended";

interface Discussion {
  id: string;
  title: string;
  status: DiscussionStatus;
}
```

它能让开发者在编译和编辑阶段发现很多错误，例如将数字传给一个要求字符串的函数。

但 TypeScript 类型通常会在编译后被移除，不能代替运行时校验。

因此，项目使用 Zod 来检查实际收到的请求：

TypeScript

```
const result = createDiscussionSchema.safeParse(req.body);

if (!result.success) {
  return res.status(400).json({
    error: result.error.flatten()
  });
}
```

两者的分工是：

* TypeScript：开发阶段检查程序内部的数据类型。

* Zod：运行时检查浏览器、网络请求或其他外部输入是否符合规则。

即使前端使用 TypeScript，用户仍然可以通过脚本发送任意 JSON，因此后端仍必须校验。

## 2. Node.js 是后端运行时，不是数据库或模型

Node.js 负责执行后端程序。Express、WebSocket 服务、文件读写、数据库访问和调用 AI 提供方都运行在这个后端进程中。

比如：

```
Node.js 进程
├── Express HTTP 服务
├── WebSocket 服务
├── 会议业务逻辑
├── SQLite 访问
├── 文件读写
└── ASR / AI 服务调用
```

这不是说每个模块都有一个独立的操作系统进程。报告描述的主要结构是由入口 `src/server/index.ts` 装配依赖，再启动 HTTP Server 和相关 WebSocket 服务。

## 3. SQLite 是嵌入式数据库，不是独立数据库服务器

项目使用 `better-sqlite3`，通过 Node.js 直接访问本地 SQLite 数据库文件，并启用 WAL 模式。

粘贴的 markdown (1)。md

它不像 PostgreSQL 那样通常需要单独启动数据库服务。

大致关系是：

```
Node.js
   │
   ▼
better-sqlite3（Node 原生绑定）
   │
   ▼
SQLite 引擎
   │
   ▼
dataDir/*.db
```

`better-sqlite3` 是访问接口，SQLite 才是真正负责 SQL 执行、事务、索引和数据持久化的数据库引擎。

# 二、HTTP、WebSocket 和 TCP：网络底层是怎样的？

理解这个项目，最关键的是理解不同协议各自解决什么问题。

## 2.1 从网络分层看

应用层

HTTP REST / WebSocket / JSON / PCM 音频

传输层

TCP：提供可靠、有序的字节流传输

网络层

IP：负责数据包寻址与路由

实际运行时，HTTP 和 WebSocket 都可以建立在 TCP 连接上。WebSocket 通常先通过 HTTP Upgrade 握手，再在同一连接上使用 WebSocket 帧进行双向通信。

项目报告明确说明，`index.ts` 使用 `http.createServer(app)` 创建 HTTP Server，再将 EventHub 和 AudioGateway 附着到同一个 Server。

粘贴的 markdown (1)。md

这意味着：

* REST 请求由 Express 路由处理。

* `/ws` 和 `/audio` 通过 HTTP Server 的 Upgrade 事件建立 WebSocket。

* 不需要为每种通信方式都单独启动一个 HTTP 服务器。

## 2.2 REST：为什么适合创建会议和保存设置？

REST API 主要使用 HTTP 请求方法表达业务操作。

|
方法

|

典型用途

|
| --- | --- |
|

GET

|

查询会议、客户、配置

|
|

POST

|

创建会议、触发 AI、上传录音

|
|

PUT

|

保存或更新设置

|
|

DELETE

|

删除会议或音频

|

例如，创建会议：

http

```
POST /api/discussions
Content-Type: application/json
```

请求体包含会议背景、参与者、模型提供方等信息。

服务器校验请求，执行相应业务逻辑，然后返回类似：

JSON

```
{
  "discussion": {
    "id": "discussion-id",
    "status": "active"
  }
}
```

这里的 JSON 是应用层数据格式，不是 TCP 自己理解的业务结构。

TCP 只负责传输字节，HTTP 负责定义请求和响应的语义，JSON 负责表达业务数据。

## 2.3 WebSocket：为什么实时会议需要长连接？

传统 HTTP 请求通常是：

```
浏览器 ── 请求 ──▶ 服务器
浏览器 ◀─ 响应 ── 服务器
```

如果会议中的每一条转写结果都由浏览器定时查询，系统就需要不断发送 HTTP 请求。

WebSocket 可以让浏览器和服务器保持连接：

```
浏览器 ◀════════════════▶ 服务器
          持续连接
```

服务器可以在识别结果产生时主动推送事件，而不必等浏览器再次请求。

这就是报告中 EventHub 的作用：将某个会议的业务事件广播给订阅该会议的客户端。

需要区分两个层次：

* WebSocket 协议本身是双向的。

* 项目 `/ws` 的业务设计主要是服务端向浏览器推送事件。

项目还按 `discussionId` 为连接分组，意味着一个会议的事件可以被限制在该会议对应的连接组中。

粘贴的 markdown (1)。md


# 三、实时音频：PCM、采样率、WAV 和语音识别

这是整套系统中最接近底层计算的部分。

普通文本可以直接使用 JSON 传输，但实时语音是连续的数字信号。要理解它，需要先理解音频在计算机中是什么。

## 3.1 麦克风采集的不是文字，而是波形

声音本来是连续的空气压力变化。麦克风将其转换为电信号，计算机再通过采样将其数字化。

三个关键参数：

|
参数

|

含义

|
| --- | --- |
|

采样率

|

每秒采集多少个音频样本

|
|

位深

|

每个样本使用多少位表示

|
|

声道数

|

单声道或立体声等

|

报告中的实时音频通道使用 16 kHz 采样率，并通过 `float32ToPcm16()` 将浏览器的浮点音频转换成 PCM16。

粘贴的 markdown (1)。md

假设音频是：

* 采样率：16000 Hz

* 位深：16 bit

* 声道数：1（单声道）

则每秒原始音频数据大小为：

16000×16÷8=32000 bytes/s16000\times16\div8=32000\text{ bytes/s}16000×16÷8=32000 bytes/s

也就是约 32 KB/s，不考虑协议头和其他开销。

一分钟约为：

32000×60=1.92 MB32000\times60=1.92\text{ MB}32000×60=1.92 MB

这解释了为什么音频不适合像普通业务请求那样，每次都转换成很大的 JSON 字符串传输。

## 3.2 PCM 和 WAV 有什么区别？

PCM

原始音频采样数据

PCM16 主要保存每个采样点的数值。它本身通常不包含完整的采样率、声道、时长等描述信息。

WAV

音频文件容器

WAV 通常使用 RIFF 容器格式，包含描述音频格式的头部以及实际音频数据。

可以把 PCM 理解成一串原始数字，而 WAV 是带有格式说明的音频文件。

报告中 `WavWriter` 接收浏览器发送的 PCM16 数据，并将它写入 WAV 文件；连接关闭时计算音频时长，再将音频资产信息写入数据库。

粘贴的 markdown (1)。md

这里的 WAV 落盘不代表语音识别一定使用这个 WAV 文件。实时识别路径是将收到的 PCM 音频块直接发送给 ASR Session，同时将音频写入磁盘。

也就是说，实时识别和录音存档是并行进行的。

## 3.3 ScriptProcessor 和音频缓冲区

报告提到前端通过：

TypeScript

```
new AudioContext()
```

和：

TypeScript

```
createScriptProcessor(4096)
```

处理麦克风音频。

`AudioContext` 是浏览器 Web Audio API 的核心对象，管理音频处理图。

`ScriptProcessor` 是旧版 Web Audio API 的音频处理节点，用来在 JavaScript 回调中处理音频缓冲区。现代浏览器开发通常更推荐 `AudioWorklet`，因为它能够把音频处理放到专门的音频线程，降低主线程阻塞对音频实时性的影响。

不过，当前报告明确记录的是 `ScriptProcessor(4096)`，不能将其说成已经使用了 AudioWorklet。

如果按 16 kHz 计算，4096 个样本约为：

4096÷16000=0.256 秒4096\div16000=0.256\text{ 秒}4096÷16000=0.256 秒

也就是约 256 毫秒一个缓冲区（实际还取决于浏览器 AudioContext 的运行采样率以及重采样处理）。

缓冲区越大，回调频率通常越低，但单次处理的延迟也越高；缓冲区越小，则对实时性更有利，但处理频率和调度开销更高。

报告只说明了 PCM 转换与音频缓冲处理，并没有完整展示浏览器端重采样算法的实现细节，因此不能仅凭 16000 这个连接参数确认所有浏览器输入音频都已经严格重采样为 16 kHz。

## 3.4 火山实时 ASR：语音怎样变成文字？

报告给出的实时链路如下：

浏览器 PCM16 音频帧

AudioGateway

接收音频、WAV 落盘、缓存未连接音频块

VolcengineAsrSession

建立 WebSocket、发送音频帧、解析服务端响应

火山引擎 ASR 云服务

语音识别模型推理

Partial

临时识别结果

Final

定稿识别结果

EventHub → 浏览器会议时间线

火山 ASR 的实时接口采用 WebSocket，报告描述了握手头、消息类型、Gzip 音频数据以及对 partial/final/error 消息的解析。

粘贴的 markdown (1)。md

这里要理解 ASR 的一个重要机制：临时结果和最终结果不是同一回事。

例如，用户说：

“我们下个季度要把……”

系统可能先返回：

```
partial: 我们下个季度
partial: 我们下个季度要把
final:   我们下个季度要把销售额提升20%
```

临时结果可以反复变化，最终结果才适合正式写入会议记录。

报告中，`onPartial` 通过 EventHub 广播临时发言，而 `onFinal` 将定稿发言保存到 SQLite，再广播 `transcript.final` 事件。

粘贴的 markdown (1)。md

# 四、AI 大脑层：CLI、HTTP API 和本地模型有什么区别？

这部分对你后续把会议系统连接到自己的本地 LLM 尤其重要。

## 4.1 Provider 模式：把模型调用抽象成统一接口

项目定义了 `CodexProvider` 接口，报告列出了：

TypeScript

```
interface CodexProvider {
  createThread(...);
  buildPrompt(...);
  respond(...);
  completePrompt(...);
}
```

这里的接口是一个抽象约定，不同模型实现只需要提供对应的方法，上层会议业务就可以通过统一方式调用它。

会议业务 / routes.ts

不直接依赖具体模型厂商

brainRegistry

按配置选择 Provider 实例

CLI Provider

Codex / Claude 子进程

HTTP Provider

OpenAI 兼容 API

这属于软件工程中的策略模式和依赖抽象思想：业务层依赖接口，而不是将所有逻辑绑定到某一个模型实现。

报告第 8 节列出了各 Provider 的实现方式。

粘贴的 markdown (1)。md


## 4.2 Codex CLI：后端如何调用一个本地命令行程序？

Codex CLI Provider 不是简单地向模型 API 发送 HTTP 请求，而是由 Node.js 启动一个操作系统子进程。

报告中明确说明，它使用 `spawn` 启动 Codex，向 stdin 写入 prompt，逐行解析 JSONL 输出，提取最终文本，并在超时情况下发送 SIGTERM。

粘贴的 markdown (1)。md

调用过程可以理解为：

Node.js 会议后端

`child_process.spawn()`

创建 Codex CLI 子进程

Codex CLI 进程

stdin 接收 prompt，stdout 输出 JSONL

Node.js 解析 JSONL，提取最终回答

再写入会议 AI 回合记录

这里涉及操作系统的三个基本概念：

* 进程：正在运行的程序实例。

* stdin/stdout：子进程的标准输入和标准输出通道。

* 信号：操作系统用于通知或控制进程的机制，例如 SIGTERM 请求进程终止。

因此，Codex CLI Provider 需要运行环境中存在可执行的 `codex` 命令，还要考虑进程超时、退出码、标准错误和进程清理等问题。

它不等于在 Node.js 进程内直接加载一个 AI 模型。 实际推理由 CLI 所连接的模型服务完成，具体连接方式取决于 CLI 配置。

Claude CLI 的机制类似，但报告中记载的是通过命令参数传入模型和 prompt，再读取进程完成后的文本。

## 4.3 OpenAI 兼容 API：为什么可以连接 DeepSeek 或自己的推理服务？

另一种方式是直接通过 HTTP 请求调用模型服务。

报告记载 `OpenAiCompatibleProvider` 使用：

```
POST {baseUrl}/v1/chat/completions
```

并根据响应中的 `finish_reason` 判断模型是否因长度限制而截断。

粘贴的 markdown (1)。md

典型的 OpenAI 兼容请求大致长这样：

http

```
POST /v1/chat/completions
Content-Type: application/json
Authorization: Bearer YOUR_API_KEY
```

请求体示例：

JSON

```
{
  "model": "model-name",
  "messages": [
    {
      "role": "system",
      "content": "你是会议决策助手。"
    },
    {
      "role": "user",
      "content": "请总结本次会议的核心分歧。"
    }
  ],
  "temperature": 0.7
}
```

这只是兼容接口的示意，并非报告中实际生成的完整请求。

关键在于：如果本地推理服务实现了相应的 OpenAI 兼容 API，客户端就可以通过配置服务地址和模型名称来调用它。

例如，你可以把部署在 WSL 中的 llama.cpp server 看作一个独立的模型推理服务：

会议后端 Node.js

OpenAiCompatibleProvider

HTTP 请求

模型名称、消息、采样参数

llama.cpp server

加载 GGUF 模型、GPU 推理、生成 token

返回模型生成的文本

后端将其保存为 AI 回合

这个架构中，会议系统和模型推理服务是两个独立进程。模型可以运行在同一台机器，也可以运行在另一台可访问的主机上。

不过，报告中列出的 Provider 注册名称为 `mock/codex-cli/claude-cli/deepseek/openai/local-qwen`，并明确注明 `local-qwen` 目前是预留但未实现、调用时抛错。

粘贴的 markdown (1)。md

因此，不能把“存在 OpenAI 兼容接口”直接等同于“已经支持所有本地模型”。还需要检查 `baseUrl` 配置、鉴权方式、请求格式、模型名和响应解析是否与本地服务兼容。

## 4.4 Prompt 工程：AI 为什么能知道会议背景？

模型本身不会自动知道这场会议的全部历史，也不会自动知道客户过去谈过什么。

这些上下文需要由后端组织成 prompt。

报告中的 AI 调用链是：

```
POST /api/discussions/:id/ai-turns
        │
        ▼
读取上次 AI 回合之后的定稿转写
        │
        ▼
读取客户记忆
        │
        ▼
promptPolicy.buildDiscussionTurnPrompt()
        │
        ▼
provider.respond(turnInput)
        │
        ▼
保存 AI 回合
```

其中，后端通过 `listFinalUtterancesSinceLastAiTurn()` 读取上次 AI 回合之后的定稿发言，再由 MemoryStore 构建客户记忆上下文。

粘贴的 markdown (1)。md

这是一种典型的上下文组装机制：

Prompt=系统指令+客户记忆+会议背景+新增发言+本轮引导\text{Prompt}= \text{系统指令}+ \text{客户记忆}+ \text{会议背景}+ \text{新增发言}+ \text{本轮引导}Prompt=系统指令+客户记忆+会议背景+新增发言+本轮引导

这个公式是概念示意，不是报告中逐字给出的 prompt 模板。

其工程意义是：会议系统负责选取上下文，模型负责根据上下文生成回答。

模型不会因为数据库里存在一条会议记录，就自动读取它。后端必须显式查询、组织并传递这些信息。


# 五、SQLite、Repository、WAL：数据究竟怎么落地？

这部分决定了会议数据能否长期保存，以及不同功能之间如何保持一致。

## 5.1 Repository：为什么不让每个路由直接写 SQL？

报告说明，`DiscussionRepository` 是唯一的数据库访问层，会议数据的读写都经由它完成。

粘贴的 markdown (1)。md

可以理解为：

业务路由

创建会议、保存发言、绑定说话人、结束会议

DiscussionRepository

统一封装 SQL、数据转换、关联查询

better-sqlite3 → SQLite

如果所有路由都直接操作 SQL，业务代码就会散布在很多地方，容易出现不同接口保存数据的规则不一致。

Repository 把数据库操作集中起来，使业务路由关注“要完成什么业务”，而不是每次都关心 SQL 的细节。

例如：

TypeScript

```
repository.createDiscussion(...)
repository.addUtterance(...)
repository.createCompletedAiTurn(...)
repository.bindSpeaker(...)
repository.endDiscussion(...)
```

这些是报告中描述的实际调用方法名称。

## 5.2 为什么会议数据要拆成多张表？

会议不是一个简单的文本字段，而是多个相互关联的业务对象。

discussions

一场会议的主记录

participants

会议参与者

utterances

逐条语音转写

ai_turns

AI 分析轮次

audio_assets

录音文件元数据

speaker_bindings

ASR 说话人标签与会议参与者的对应关系

这种设计属于关系型数据建模。

比如，同一场会议可以有很多发言、很多 AI 回合、多个参与者以及多段录音。把这些数据拆开，可以避免将所有内容重复塞入会议主记录。

报告还说明，数据库使用外键级联删除。它可以帮助维持数据库内部的关联完整性，但磁盘中的 WAV 文件并不属于 SQLite 外键能够自动删除的对象，因此项目还需要显式处理音频文件的删除。

粘贴的 markdown (1)。md

## 5.3 WAL 模式：SQLite 如何处理读写？

SQLite 的 WAL 全称是 Write-Ahead Logging（预写日志）。

普通数据库写入时，WAL 模式会先把修改记录写入 WAL 日志，再由 checkpoint 将日志中的内容合并回主数据库文件。

它的一个重要好处是，在适当的使用条件下，读操作和写操作可以更好地并行进行。

例如：

```
会议浏览器 A ── 查询会议 ──┐
                            ▼
                       SQLite WAL
                            ▲
会议浏览器 B ── 保存发言 ──┘
```

但这里有一个容易误解的地方：WAL 不代表 SQLite 变成了一个可以无限并发写入的数据库。

SQLite 仍然需要协调写事务，同一时刻的写操作受到锁和事务机制约束。

`better-sqlite3` 的数据库操作通常是同步执行的。较长的数据库查询或同步操作可能占用 Node.js 事件循环线程。因此，对实时系统来说，数据库操作应当尽量短小，避免在主事件循环中执行耗时计算。

对于这个项目，音频帧本身写入 WAV 文件，识别结果再保存为数据库记录，这种分工有利于避免将连续的大量 PCM 数据作为普通 SQL 写操作处理。

# 六、Node.js 事件循环：为什么一个服务能同时处理多个会议？

这是理解后端性能的核心。

Node.js 通常采用事件驱动、非阻塞 I/O 的方式处理网络请求。

例如：

```
请求 A：等待火山 ASR 返回
请求 B：查询会议列表
请求 C：等待 DeepSeek 返回
请求 D：接收另一场会议的音频
```

当请求 A 等待网络数据时，Node.js 可以继续处理其他已经就绪的任务，而不需要为每一个网络等待都创建一个独立线程。

但要区分两类工作。

|
工作类型

|

例子

|

对事件循环的影响

|
| --- | --- | --- |
|

网络 I/O 等待

|

等待 ASR、等待模型 HTTP 响应

|

通常不会一直占用 JS 主线程

|
|

CPU 密集计算

|

大量同步计算、复杂音频处理

|

可能阻塞事件循环

|
|

同步数据库操作

|

`better-sqlite3` 同步查询

|

执行期间占用当前线程

|
|

子进程等待

|

等待 Codex CLI 完成

|

Node.js 可继续处理其他 I/O，但进程资源仍然存在

|

报告中 AI Provider 有 CLI 子进程实现，也有 HTTP 实现。这使模型调用的等待时间不必全部阻塞 Node.js 主线程。

不过，这不代表系统可以无限制地同时调用模型。

实际吞吐量还受以下因素约束：

* 模型服务的并发限制和 GPU 显存。

* 子进程数量和系统资源。

* SQLite 写入竞争。

* WebSocket 缓冲区及网络带宽。

* ASR 服务的连接限制。

前端的 `SingleFlight` 主要限制重复触发的业务操作，例如重复上传或重复邀请 AI。它不是整个服务器的全局并发调度器。

粘贴的 markdown (1)。md

如果以后要让很多用户同时召开会议，仍然需要考虑后端任务队列、并发上限、超时、限流和资源隔离。

# 七、客户记忆和演示隔离：数据管理的底层原理

## 7.1 客户记忆并不是模型自动记住的

报告中的 `MemoryStore` 负责管理客户资料、滚动记忆、说话人映射和待确认的记忆草稿。

数据结构包括：

```
customersDir/<id>/
├── company-profile.json
├── company-profile.md
├── rolling-memory.json
├── rolling-memory.md
├── speaker-map.json
└── pending-memory-drafts/
    └── <discussionId>.json
```

来源：报告第 7.8 节和第 11 节。

粘贴的 markdown (1)。md

这套设计实际上把两种信息分开：

* 原始会议记录：保存会议中实际发生的事情。

* 客户记忆：将多次会议中值得长期使用的信息整理成精简上下文。

记忆沉淀的流程不是让模型直接修改永久记忆，而是先生成草稿，再由用户确认：

```
历史会议
   │
   ▼
生成记忆草稿
   │
   ▼
用户编辑和确认
   │
   ▼
更新 rolling-memory
   │
   ▼
后续 AI 会议调用时作为上下文
```

这种人工确认机制很重要，因为模型总结出来的信息可能存在误解、遗漏或错误归因。草稿与正式记忆分离，可以让用户在信息进入长期客户档案之前进行审核。

## 7.2 DemoWorkspace：为什么要创建两套后端依赖？

报告描述，普通工作区和演示工作区在启动时分别创建独立的数据库、Repository、MemoryStore 和 AudioGateway。演示数据位于独立的 `dataDir/demo` 路径。

粘贴的 markdown (1)。md

可以将它理解为应用内部的两个工作区：

Normal Workspace

真实会议数据

SQLite 数据库、会议 Repository、客户记忆、音频目录。

Demo Workspace

演示会议数据

独立数据库、独立 Repository、独立记忆存储、独立音频网关。

这是一种应用级工作区隔离，不等同于 Docker 容器隔离、独立操作系统用户或独立服务器。

两套对象可以在同一个 Node.js 进程中运行。

因此，这种设计主要解决业务数据混用的问题；它本身并不能证明两个工作区的 CPU、内存、系统权限或模型 API 凭证也完全隔离。

# 八、最后把整套底层技术串起来

如果从一次会议的生命周期来看，整套系统可以归纳为以下四条主链路。

## AI Meeting Workstation 四条核心链路

业务链路

React → REST → Express → Repository → SQLite

创建会议、参与者管理、结束会议、查询历史、设置管理。

实时音频链路

麦克风 → PCM → WebSocket → ASR → 文字事件

采集音频、语音识别、转写持久化、事件推送。

AI 推理链路

会议上下文 → Prompt → Provider → LLM → AI 回合

选择上下文，调用 CLI 或 API，保存 AI 回答并推送前端。

记忆链路

会议记录 → 记忆草稿 → 人工确认 → 客户记忆

把会议中的长期有效信息沉淀为后续 AI 可用的上下文。

## 对你后续本地部署最有用的结论

结合这份报告，如果目标是让会议系统运行在你自己的电脑和 WSL 环境中，需要分清三个独立的计算服务：

|
服务

|

可以在哪里运行

|

负责什么

|
| --- | --- | --- |
|

React + Express

|

Windows 或 WSL

|

界面和会议业务

|
|

ASR

|

火山云或支持的本地 ASR 环境

|

语音转文字

|
|

LLM 推理服务

|

云端 API 或本地 llama.cpp

|

会议分析和回答

|

其中，SQLite 和音频文件可以存放在后端所在机器的本地磁盘上。

目前报告已经支持的判断是： 项目有本地 CLI 调用能力、有 OpenAI 兼容 API 调用能力、有本地 FunASR 文件转录能力；但报告明确将 `local-qwen` 标为未实现。因此，真正把你的 llama.cpp 服务接进来，重点不是重写会议系统，而是检查并实现一个能够正确处理本地推理服务配置、请求和响应的 Provider。

这也是这套架构采用 Provider 抽象最实际的价值：会议管理、实时音频、数据库和前端界面可以保持不变，而 AI 推理后端可以单独替换。
