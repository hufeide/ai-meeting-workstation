import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DiscussionRepository } from "../discussions/repository";
import type { StoragePaths } from "../storage/paths";

export type FunasrUploadResult = {
  transcript: string;
  utteranceCount: number;
  transcriptPath: string;
};

type FunasrFileTranscriberConfig = {
  pythonPath?: string;
  scriptPath?: string;
  asrHome?: string;
  timeoutMs?: number;
  device?: "auto" | "cpu" | "mps" | "cuda" | `cuda:${number}`;
  hotwordFile?: string;
};

type SpeakerSegment = {
  start?: number;
  end?: number;
  speaker?: string;
  text?: string;
};

export class FunasrFileTranscriber {
  private readonly pythonPath: string;
  private readonly scriptPath: string;
  private readonly asrHome: string;
  private readonly timeoutMs: number;
  private readonly device: "auto" | "cpu" | "mps" | "cuda" | `cuda:${number}`;
  private readonly hotwordFile?: string;

  constructor(
    private readonly deps: {
      repository: DiscussionRepository;
      storagePaths: StoragePaths;
    },
    config: FunasrFileTranscriberConfig = {}
  ) {
    this.pythonPath = config.pythonPath ?? "python3";
    this.scriptPath =
      config.scriptPath ?? fileURLToPath(new URL("../../../scripts/transcribe_audio.py", import.meta.url));
    this.asrHome = config.asrHome ?? process.cwd();
    // Keep the standalone fallback aligned with the production default. A
    // multi-hour recording can legitimately need tens of minutes on CPU.
    this.timeoutMs = config.timeoutMs ?? 21_600_000;
    this.device = config.device ?? "auto";
    this.hotwordFile = config.hotwordFile;
  }

  async transcribeUpload(input: { discussionId: string; filename: string; audio: Buffer }): Promise<FunasrUploadResult> {
    if (!isRunnablePython(this.pythonPath)) {
      throw new Error(`本地 FunASR Python 不可用：${this.pythonPath}`);
    }
    if (!existsSync(this.scriptPath)) {
      throw new Error(`FunASR 转写脚本不存在：${this.scriptPath}`);
    }
    if (this.hotwordFile && !existsSync(this.hotwordFile)) {
      throw new Error(`FunASR 专有名词词表不存在：${this.hotwordFile}`);
    }

    const discussionDir = join(this.deps.storagePaths.discussionsDir, input.discussionId);
    const uploadDir = join(discussionDir, "uploads", `${Date.now()}-${safeFilename(input.filename)}`);
    mkdirSync(uploadDir, { recursive: true });
    const audioPath = join(uploadDir, safeFilename(input.filename));
    const outputDir = join(uploadDir, "funasr-output");
    await BunLikeWriteFile(audioPath, input.audio);

    await this.runFunasr({ audioPath, outputDir });
    const transcriptPath = join(outputDir, "transcript.txt");
    const transcript = readFileSync(transcriptPath, "utf8").trim();
    const segmentsPath = join(outputDir, "speaker_segments.json");
    const segments = existsSync(segmentsPath) ? (JSON.parse(readFileSync(segmentsPath, "utf8")) as SpeakerSegment[]) : [];
    const utteranceCount = this.writeUtterances(input.discussionId, transcript, segments);

    this.deps.repository.createAudioAsset({
      discussionId: input.discussionId,
      path: audioPath,
      format: basename(audioPath).split(".").at(-1) || "audio",
      source: "browser"
    });

    return {
      transcript,
      utteranceCount,
      transcriptPath
    };
  }

  private writeUtterances(discussionId: string, transcript: string, segments: SpeakerSegment[]): number {
    if (segments.length > 0) {
      for (const segment of segments) {
        const text = String(segment.text || "").trim();
        if (!text) continue;
        this.deps.repository.addUtterance({
          discussionId,
          speakerLabel: normalizeSpeaker(segment.speaker),
          text,
          startMs: asMs(segment.start),
          endMs: asMs(segment.end),
          isFinal: true,
          source: "funasr",
          rawEvent: segment
        });
      }
      return segments.filter((segment) => String(segment.text || "").trim()).length;
    }

    const lines = transcript
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) return 0;
    for (const line of lines) {
      const match = line.match(/^\[[^\]]+\]\s*([^:：]+)[:：]\s*(.+)$/);
      this.deps.repository.addUtterance({
        discussionId,
        speakerLabel: match ? normalizeSpeaker(match[1]) : "speaker_0",
        text: match ? match[2].trim() : line,
        isFinal: true,
        source: "funasr"
      });
    }
    return lines.length;
  }

  private runFunasr(input: { audioPath: string; outputDir: string }): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = [
        this.scriptPath,
        "--input",
        input.audioPath,
        "--output-dir",
        input.outputDir,
        "--asr-home",
        this.asrHome,
        "--device",
        this.device,
        "--speaker-diarization"
      ];
      if (this.hotwordFile) {
        args.push("--hotword-file", this.hotwordFile);
      }
      const child = spawn(this.pythonPath, args);
      let stderr = "";
      let stdout = "";
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, this.timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timeout);
        if (timedOut) {
          reject(new Error(`FunASR 转写超时，已超过 ${this.timeoutMs}ms。`));
          return;
        }
        if (code !== 0) {
          reject(new Error(`FunASR 转写失败（exit ${code}）：${summarize(stderr || stdout)}`));
          return;
        }
        resolve();
      });
    });
  }
}

async function BunLikeWriteFile(path: string, data: Buffer): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, data);
}

function isRunnablePython(command: string): boolean {
  if (command.includes("/") || command.includes("\\")) return existsSync(command);
  return spawnSync(command, ["--version"], { stdio: "ignore" }).status === 0;
}

function safeFilename(value: string): string {
  return basename(value || "upload.wav").replace(/[^0-9A-Za-z\u4e00-\u9fa5_.-]+/g, "-").slice(0, 120) || "upload.wav";
}

function normalizeSpeaker(value: unknown): string {
  const text = String(value || "speaker_0").trim();
  if (!text) return "speaker_0";
  return text.toLowerCase().startsWith("speaker") ? text.replace(/\s+/g, "_").toLowerCase() : `speaker_${text}`;
}

function asMs(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function summarize(value: string): string {
  return (
    value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-4)
      .join("；") || "没有错误输出。"
  );
}
