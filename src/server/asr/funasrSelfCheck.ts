import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { parseBridgeLine, type FunasrRealtimeConfig } from "./funasrRealtimeAsr";

export type FunasrSelfCheckStatus = "pending" | "running" | "ok" | "error";
export type FunasrSelfCheckResult = {
  status: FunasrSelfCheckStatus;
  modelsLoaded: boolean;
  transcriptionWorks: boolean | null;
  device: string;
  message: string;
  durationMs: number | null;
  checkedAt: string | null;
};

const PENDING: FunasrSelfCheckResult = {
  status: "pending",
  modelsLoaded: false,
  transcriptionWorks: null,
  device: "",
  message: "尚未自检",
  durationMs: null,
  checkedAt: null
};

let cache: FunasrSelfCheckResult = { ...PENDING };
let current: Promise<FunasrSelfCheckResult> | null = null;

export function getFunasrSelfCheck(): FunasrSelfCheckResult {
  return cache;
}

export function runFunasrSelfCheck(config: FunasrRealtimeConfig): Promise<FunasrSelfCheckResult> {
  if (current) return current;
  current = (async () => {
    const started = Date.now();
    cache = { ...PENDING, status: "running", device: config.device };
    try {
      const result = await probe(config, started);
      cache = result;
      return result;
    } catch (error) {
      const result: FunasrSelfCheckResult = {
        status: "error",
        modelsLoaded: false,
        transcriptionWorks: null,
        device: config.device,
        message: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - started,
        checkedAt: new Date().toISOString()
      };
      cache = result;
      return result;
    } finally {
      current = null;
    }
  })();
  return current;
}

const MODEL_LOAD_TIMEOUT_MS = 180_000;
const INFERENCE_TIMEOUT_MS = 45_000;
const BRIDGE_EXIT_TIMEOUT_MS = 20_000;

async function probe(config: FunasrRealtimeConfig, started: number): Promise<FunasrSelfCheckResult> {
  const python = config.pythonPath ?? "python3";
  const scriptPath = config.scriptPath ?? fileURLToPath(new URL("../../../scripts/realtime_funasr.py", import.meta.url));
  if (!existsSync(scriptPath)) {
    throw new Error(`找不到实时 FunASR 脚本：${scriptPath}`);
  }

  const child = spawn(python, [scriptPath, "--asr-home", config.asrHome, "--device", config.device], {
    stdio: ["pipe", "pipe", "pipe"]
  });

  let modelsLoaded = false;
  let transcriptionWorks: boolean | null = null;
  let bridgeErrorMessage = "";
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const readyPromise = new Promise<void>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });
  let finalResolved = false;
  let resolveFinal: (() => void) | null = null;
  const finalPromise = new Promise<void>((res) => {
    resolveFinal = res;
  });

  const fail = (message: string) => {
    if (!modelsLoaded) rejectReady(new Error(message));
  };

  child.on("error", (error) => fail(`无法启动 FunASR 桥进程：${error.message}`));
  child.on("exit", (code) => {
    if (!modelsLoaded && code !== 0) fail(`FunASR 桥进程异常退出（code=${code}），请确认 Python/funasr 可用且模型已下载。`);
  });

  let buffer = "";
  child.stdout?.on("data", (data: Buffer) => {
    buffer += data.toString("utf8");
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      const message = parseBridgeLine(line);
      if (!message) continue;
      if (message.type === "ready") {
        modelsLoaded = true;
        resolveReady();
      } else if (message.type === "final") {
        finalResolved = true;
        resolveFinal?.();
      } else if (message.type === "error") {
        bridgeErrorMessage = message.message;
        fail(`FunASR 桥报错：${message.message}`);
      }
    }
  });

  const loadTimeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`模型加载超时（>${MODEL_LOAD_TIMEOUT_MS / 1000}s）：请检查模型是否已下载、GPU/显存是否可用。`)), MODEL_LOAD_TIMEOUT_MS)
  );
  try {
    await Promise.race([readyPromise, loadTimeout]);
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }

  const demo = resolve(process.cwd(), "assets/demo/chengyuan-tech-fallback-open-kokoro.wav");
  const ffmpegAvailable = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
  if (existsSync(demo) && ffmpegAvailable && child.stdin) {
    const ffmpeg = spawn("ffmpeg", ["-i", demo, "-t", "6", "-f", "s16le", "-ac", "1", "-ar", "16000", "-loglevel", "error", "-"]);
    ffmpeg.stdout?.on("data", (chunk: Buffer) => {
      try {
        child.stdin?.write(chunk);
      } catch {
        /* bridge 已关闭则忽略 */
      }
    });
    ffmpeg.on("close", () => {
      try {
        child.stdin?.end();
      } catch {
        /* 忽略 */
      }
    });
    const inferenceTimeout = new Promise<void>((resolve) => setTimeout(resolve, INFERENCE_TIMEOUT_MS));
    await Promise.race([finalPromise, inferenceTimeout]);
    transcriptionWorks = finalResolved ? true : false;
  } else {
    transcriptionWorks = null;
    try {
      child.stdin?.end();
    } catch {
      /* 忽略 */
    }
  }

  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, BRIDGE_EXIT_TIMEOUT_MS);
    child.on("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });

  if (bridgeErrorMessage) throw new Error(bridgeErrorMessage);

  const message =
    transcriptionWorks === true
      ? "模型已加载，且演示音频可正常转写。"
      : transcriptionWorks === false
        ? "模型已加载，但演示音频未产出转写（请检查音频/采样率）。"
        : "模型已加载（本机无演示音频或 ffmpeg，未做推理验证）。";

  return {
    status: "ok",
    modelsLoaded: true,
    transcriptionWorks,
    device: config.device,
    message,
    durationMs: Date.now() - started,
    checkedAt: new Date().toISOString()
  };
}
