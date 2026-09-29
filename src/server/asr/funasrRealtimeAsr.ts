import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AsrEventLogEntry } from "./asrEventLog";
import type { AsrProvider, AsrProviderStartInput, TranscriptCandidate } from "./asrProvider";

export type FunasrRealtimeConfig = {
  pythonPath?: string;
  scriptPath?: string;
  asrHome: string;
  device: string;
  speakerDiarization?: boolean;
};

export class FunasrRealtimeAsrProvider implements AsrProvider {
  constructor(private readonly config: FunasrRealtimeConfig) {}

  checkCredentials(): ReturnType<AsrProvider["checkCredentials"]> {
    const python = this.config.pythonPath ?? "python3";
    if (!isRunnablePython(python)) {
      return {
        ok: false,
        message: `本地 FunASR 实时 Python 不可用：${python}。请在 .env 配置 FUNASR_PYTHON_PATH 指向已安装 funasr 的解释器。`
      };
    }
    return { ok: true };
  }

  async startSession(input: AsrProviderStartInput): Promise<FunasrRealtimeSession> {
    const python = this.config.pythonPath ?? "python3";
    const scriptPath =
      this.config.scriptPath ?? fileURLToPath(new URL("../../../scripts/realtime_funasr.py", import.meta.url));
    if (!existsSync(scriptPath)) {
      throw new Error(`找不到实时 FunASR 脚本：${scriptPath}`);
    }
    const args = ["--asr-home", this.config.asrHome, "--device", this.config.device];
    if (this.config.speakerDiarization) args.push("--speaker");
    const child = spawn(python, [scriptPath, ...args], { stdio: ["pipe", "pipe", "pipe"] });
    const session = new FunasrRealtimeSession(child, input);
    if (input.abort) {
      const onAbort = () => {
        session.abort();
      };
      if (input.abort.aborted) {
        onAbort();
      } else {
        input.abort.addEventListener("abort", onAbort, { once: true });
      }
    }
    await session.waitReady();
    return session;
  }
}

type BridgeMessage =
  | { type: "ready" }
  | { type: "final"; text: string; start: number; end: number; speaker: string }
  | { type: "error"; message: string }
  | { type: "done" };

export function parseBridgeLine(line: string): BridgeMessage | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as BridgeMessage;
  } catch {
    return null;
  }
}

export function applyBridgeMessage(message: BridgeMessage, callbacks: AsrProviderStartInput): void {
  switch (message.type) {
    case "ready":
      break;
    case "final":
      callbacks.onFinal({
        speakerLabel: message.speaker || "speaker_0",
        text: message.text,
        startMs: message.start,
        endMs: message.end
      } satisfies TranscriptCandidate);
      break;
    case "error":
      callbacks.onError(message.message);
      break;
    case "done":
      break;
  }
}

class FunasrRealtimeSession {
  private buffer = "";
  private resolveReady?: () => void;
  private rejectReady?: (error: Error) => void;
  private rejected = false;
  private closed = false;
  private readyResolved = false;
  private killedByUs = false;
  readonly ready: Promise<void> = new Promise((resolve, reject) => {
    this.resolveReady = resolve;
    this.rejectReady = reject;
  });

  constructor(
    private readonly child: ChildProcess,
    private readonly callbacks: AsrProviderStartInput
  ) {
    child.stdout?.on("data", (data) => this.onData(Buffer.from(data)));
    child.stderr?.on("data", (data) =>
      this.callbacks.onLog?.({
        direction: "server",
        eventType: "realtime-stderr",
        payloadSummary: String(data).slice(0, 300)
      })
    );
    child.on("error", (error) => this.fail(new Error(`本地 FunASR 实时桥启动失败：${error.message}`)));
    child.on("exit", (code, signal) => {
      if (this.killedByUs) return;
      if (code && code !== 0) {
        this.fail(new Error(`本地 FunASR 实时桥异常退出（code=${code}${signal ? `, signal=${signal}` : ""}）。`));
      }
    });
  }

  waitReady(): Promise<void> {
    return this.ready;
  }

  sendAudio(chunk: Buffer): void {
    if (this.child.stdin?.writable) this.child.stdin.write(chunk);
  }

  abort(): void {
    if (this.closed) return;
    this.closed = true;
    this.killedByUs = true;
    this.rejectReady?.(new Error("FunASR 实时会话已在模型加载完成前中止。"));
    this.rejectReady = undefined;
    try {
      this.child.kill("SIGTERM");
    } catch {
      // 忽略
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.killedByUs = true;
    try {
      this.child.stdin?.end();
    } catch {
      // 忽略：子进程可能已退出
    }
    if (!this.readyResolved) {
      // 模型尚未就绪就关闭（如用户在加载期间停止/刷新页面）：直接结束子进程，
      // 否则会留下孤儿 python 持续占用 GPU。多次重复后 GPU 被占满，后续加载会 OOM 崩溃，
      // 表现为“模型加载完就卸载、没有转写”。
      this.rejectReady?.(new Error("FunASR 实时会话在模型加载完成前已关闭。"));
      this.rejectReady = undefined;
      try {
        this.child.kill("SIGTERM");
      } catch {
        // 忽略
      }
    }
  }

  private fail(error: Error): void {
    if (!this.rejected) {
      this.rejected = true;
      this.rejectReady?.(error);
      this.rejectReady = undefined;
    }
    this.callbacks.onError(error.message);
  }

  private onData(data: Buffer): void {
    this.buffer += data.toString("utf8");
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      const message = parseBridgeLine(line);
      if (message?.type === "ready") {
        this.readyResolved = true;
        this.resolveReady?.();
        this.resolveReady = undefined;
        continue;
      }
      if (message) applyBridgeMessage(message, this.callbacks);
    }
  }
}

function isRunnablePython(command: string): boolean {
  if (command.includes("/") || command.includes("\\")) return existsSync(command);
  return spawnSync(command, ["--version"], { stdio: "ignore" }).status === 0;
}
