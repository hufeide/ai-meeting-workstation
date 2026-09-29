import { spawnSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { applyBridgeMessage, parseBridgeLine } from "./funasrRealtimeAsr";
import type { AsrProviderStartInput } from "./asrProvider";

describe("parseBridgeLine", () => {
  it("解析 final/error JSONL", () => {
    expect(parseBridgeLine('{"type":"final","text":"你好。","start":0,"end":1000,"speaker":"speaker_1"}')).toMatchObject({
      type: "final",
      text: "你好。",
      speaker: "speaker_1"
    });
    expect(parseBridgeLine('{"type":"error","message":"boom"}')).toEqual({ type: "error", message: "boom" });
  });

  it("空行/非法 JSON 返回 null", () => {
    expect(parseBridgeLine("")).toBeNull();
    expect(parseBridgeLine("   ")).toBeNull();
    expect(parseBridgeLine("not json")).toBeNull();
  });
});

describe("applyBridgeMessage", () => {
  it("final 映射为 onFinal 且字段正确", () => {
    const finals: unknown[] = [];
    const errors: string[] = [];
    const cb: AsrProviderStartInput = {
      discussionId: "x",
      onFinal: (u) => finals.push(u),
      onError: (m) => errors.push(m),
      onPartial: () => {},
      onLog: () => {}
    };
    applyBridgeMessage({ type: "final", text: "你好。", start: 0, end: 1000, speaker: "speaker_1" }, cb);
    expect(finals).toEqual([{ speakerLabel: "speaker_1", text: "你好。", startMs: 0, endMs: 1000 }]);
    expect(errors).toEqual([]);
  });

  it("缺省/空 speaker 回退 speaker_0", () => {
    const finals: unknown[] = [];
    const cb: AsrProviderStartInput = {
      discussionId: "x",
      onFinal: (u) => finals.push(u),
      onError: () => {},
      onPartial: () => {},
      onLog: () => {}
    };
    applyBridgeMessage({ type: "final", text: "x", start: 1, end: 2, speaker: "" }, cb);
    expect((finals[0] as { speakerLabel: string }).speakerLabel).toBe("speaker_0");
  });

  it("error 触发 onError", () => {
    const errors: string[] = [];
    const cb: AsrProviderStartInput = {
      discussionId: "x",
      onFinal: () => {},
      onError: (m) => errors.push(m),
      onPartial: () => {},
      onLog: () => {}
    };
    applyBridgeMessage({ type: "error", message: "boom" }, cb);
    expect(errors).toEqual(["boom"]);
  });

  it("ready/done 不触发任何回调", () => {
    let calls = 0;
    const cb: AsrProviderStartInput = {
      discussionId: "x",
      onFinal: () => calls++,
      onError: () => calls++,
      onPartial: () => {},
      onLog: () => {}
    };
    applyBridgeMessage({ type: "ready" }, cb);
    applyBridgeMessage({ type: "done" }, cb);
    expect(calls).toBe(0);
  });
});

// 真实集成测试：需本地模型 + ffmpeg + python，默认跳过；设 FUNASR_REALTIME_TEST=1 启用。
const HOME = process.env.FUNASR_HOME || resolve(process.cwd());
const DEVICE = process.env.FUNASR_DEVICE || "cuda";
const DEMO = resolve(process.cwd(), "assets/demo/chengyuan-tech-fallback-open-kokoro.wav");

function findPython(): string | undefined {
  for (const c of [process.env.FUNASR_PYTHON_PATH, "python3", "python"].filter(Boolean) as string[]) {
    if (c.includes("/") || c.includes("\\")) {
      if (existsSync(c)) return c;
    } else if (spawnSync(c, ["--version"], { stdio: "ignore" }).status === 0) {
      return c;
    }
  }
  return undefined;
}

const canRun =
  process.env.FUNASR_REALTIME_TEST === "1" &&
  !!findPython() &&
  existsSync(DEMO) &&
  existsSync(resolve(HOME, ".modelscope_cache")) &&
  spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;

describe.skipIf(!canRun)("FunasrRealtimeAsrProvider 真实集成", () => {
  it("startSession+sendAudio 把演示音频流式转写成 >=1 句带标点文本", async () => {
    const { FunasrRealtimeAsrProvider } = await import("./funasrRealtimeAsr");
    const provider = new FunasrRealtimeAsrProvider({
      pythonPath: findPython()!,
      asrHome: HOME,
      device: DEVICE,
      speakerDiarization: false
    });
    const finals: unknown[] = [];
    const errors: string[] = [];
    const session = await provider.startSession({
      discussionId: "rt",
      onFinal: (u) => finals.push(u),
      onError: (m) => errors.push(m),
      onPartial: () => {},
      onLog: () => {}
    });
    const ffmpeg = spawn("ffmpeg", ["-i", DEMO, "-t", "20", "-f", "s16le", "-ac", "1", "-ar", "16000", "-loglevel", "error", "-"]);
    ffmpeg.stdout!.on("data", (b: Buffer) => session.sendAudio(b));
    await new Promise<void>((res) => ffmpeg.on("close", () => {
      session.close();
      res();
    }));
    await new Promise((r) => setTimeout(r, 8000));
    expect(errors, errors.join("\n")).toEqual([]);
    expect(finals.length, JSON.stringify(finals)).toBeGreaterThan(0);
    expect(finals.some((f) => (f as { text: string }).text.trim().length > 0)).toBe(true);
  }, 180000);
});
