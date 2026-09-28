import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { DiscussionRepository } from "../discussions/repository";
import type { StoragePaths } from "../storage/paths";

const DEFAULT_SUBMIT_ENDPOINT = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit";
const DEFAULT_QUERY_ENDPOINT = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/query";
const DEFAULT_RESOURCE_ID = "volc.seedasr.auc";
const MAX_FILE_BYTES = 200 * 1024 * 1024;
const SUPPORTED_FORMATS = new Set(["raw", "wav", "mp3", "ogg", "pcm", "spx", "amr", "aac", "m4a"]);

type VolcengineFileConfig = {
  apiKey?: string;
  submitEndpoint?: string;
  queryEndpoint?: string;
  resourceId?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
};

type VolcengineFileUtterance = {
  text?: string;
  start_time?: number;
  end_time?: number;
  additions?: {
    speaker?: string | number;
    channel_id?: string | number;
  };
};

type VolcengineFileResponse = {
  result?: {
    text?: string;
    utterances?: VolcengineFileUtterance[];
  };
};

export type VolcengineFileUploadResult = {
  transcript: string;
  utteranceCount: number;
  transcriptPath: string;
};

export class VolcengineFileTranscriber {
  private readonly submitEndpoint: string;
  private readonly queryEndpoint: string;
  private readonly resourceId: string;
  private readonly timeoutMs: number;
  private readonly request: typeof fetch;

  constructor(
    private readonly deps: {
      repository: DiscussionRepository;
      storagePaths: StoragePaths;
    },
    private readonly config: VolcengineFileConfig
  ) {
    this.submitEndpoint = config.submitEndpoint ?? DEFAULT_SUBMIT_ENDPOINT;
    this.queryEndpoint = config.queryEndpoint ?? DEFAULT_QUERY_ENDPOINT;
    this.resourceId = config.resourceId ?? DEFAULT_RESOURCE_ID;
    this.timeoutMs = config.timeoutMs ?? 10 * 60 * 1000;
    this.request = config.fetch ?? fetch;
  }

  async transcribeUpload(input: {
    discussionId: string;
    filename: string;
    audio: Buffer;
  }): Promise<VolcengineFileUploadResult> {
    const apiKey = this.config.apiKey?.trim();
    if (!apiKey) throw new Error("缺少火山 ASR API Key，请先在会议设置中保存。");
    if (input.audio.byteLength > MAX_FILE_BYTES) {
      throw new Error("当前产品单次上传不能超过 200MB，请改用本地 FunASR 或压缩录音。");
    }

    const filename = safeFilename(input.filename);
    const format = extname(filename).slice(1).toLowerCase();
    if (!SUPPORTED_FORMATS.has(format)) {
      throw new Error("火山录音文件识别不支持该格式，请上传 WAV、MP3、OGG、AAC、M4A 等音频文件。");
    }

    const requestId = randomUUID();
    const headers = {
      "Content-Type": "application/json",
      "X-Api-Key": apiKey,
      "X-Api-Resource-Id": this.resourceId,
      "X-Api-Request-Id": requestId
    };
    const response = await this.request(this.submitEndpoint, {
      method: "POST",
      headers: { ...headers, "X-Api-Sequence": "-1" },
      body: JSON.stringify({
        user: { uid: "meeting-workstation-local" },
        audio: {
          data: input.audio.toString("base64"),
          format
        },
        request: {
          model_name: "bigmodel",
          enable_itn: true,
          enable_punc: true,
          enable_ddc: false,
          show_utterances: true,
          enable_speaker_info: true
        }
      }),
      signal: AbortSignal.timeout(this.timeoutMs)
    });

    await assertSuccessfulSubmit(response);
    const payload = await this.pollResult(headers);

    const transcript = String(payload.result?.text ?? "").trim();
    const utterances = payload.result?.utterances ?? [];
    if (!transcript && utterances.length === 0) {
      throw new Error("火山录音文件识别成功返回，但没有可用的转写文本。");
    }

    const discussionDir = join(this.deps.storagePaths.discussionsDir, input.discussionId);
    const uploadDir = join(discussionDir, "uploads", `${Date.now()}-${filename}`);
    await mkdir(uploadDir, { recursive: true });
    const audioPath = join(uploadDir, filename);
    const transcriptPath = join(uploadDir, "volcengine-transcript.txt");
    await writeFile(audioPath, input.audio);
    await writeFile(transcriptPath, `${transcript || utterances.map((item) => item.text).filter(Boolean).join("\n")}\n`, "utf8");

    const utteranceCount = writeUtterances(this.deps.repository, input.discussionId, transcript, utterances);
    this.deps.repository.createAudioAsset({
      discussionId: input.discussionId,
      path: audioPath,
      format,
      source: "browser"
    });

    return { transcript, utteranceCount, transcriptPath };
  }

  private async pollResult(headers: Record<string, string>): Promise<VolcengineFileResponse> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < this.timeoutMs) {
      const response = await this.request(this.queryEndpoint, {
        method: "POST",
        headers,
        body: "{}",
        signal: AbortSignal.timeout(Math.min(120_000, this.timeoutMs))
      });
      const statusCode = response.headers.get("X-Api-Status-Code") ?? "";
      const vendorMessage = response.headers.get("X-Api-Message") ?? "";
      const payload = (await response.json().catch(() => ({}))) as VolcengineFileResponse;
      if (response.ok && statusCode === "20000000") return payload;
      if (statusCode !== "20000001" && statusCode !== "20000002") {
        throw new Error(mapVolcengineFileError(response.status, statusCode, vendorMessage));
      }
      await delay(1_000);
    }
    throw new Error("火山录音文件识别超时，云端任务仍未返回结果，请稍后重试。");
  }
}

async function assertSuccessfulSubmit(response: Response): Promise<void> {
  const statusCode = response.headers.get("X-Api-Status-Code") ?? "";
  const vendorMessage = response.headers.get("X-Api-Message") ?? "";
  if (response.ok && statusCode === "20000000") return;
  await response.arrayBuffer().catch(() => undefined);
  throw new Error(mapVolcengineFileError(response.status, statusCode, vendorMessage));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function writeUtterances(
  repository: DiscussionRepository,
  discussionId: string,
  transcript: string,
  utterances: VolcengineFileUtterance[]
): number {
  const usable = utterances.filter((item) => String(item.text ?? "").trim());
  if (usable.length > 0) {
    for (const item of usable) {
      repository.addUtterance({
        discussionId,
        speakerLabel: normalizeVolcengineFileSpeaker(item),
        text: String(item.text).trim(),
        startMs: finiteNumber(item.start_time),
        endMs: finiteNumber(item.end_time),
        isFinal: true,
        source: "volcengine-file",
        rawEvent: item
      });
    }
    return usable.length;
  }

  repository.addUtterance({
    discussionId,
    speakerLabel: "speaker_0",
    text: transcript,
    isFinal: true,
    source: "volcengine-file"
  });
  return 1;
}

export function normalizeVolcengineFileSpeaker(item: VolcengineFileUtterance): string {
  const value = item.additions?.speaker ?? item.additions?.channel_id ?? 0;
  const numericLabel = Number(String(value).replace(/^speaker[_ -]?/i, ""));
  if (!Number.isFinite(numericLabel) || numericLabel <= 0) return "speaker_0";
  return `speaker_${Math.floor(numericLabel) - 1}`;
}

function finiteNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function safeFilename(value: string): string {
  return basename(value || "upload.wav").replace(/[^0-9A-Za-z\u4e00-\u9fa5_.-]+/g, "-").slice(0, 120) || "upload.wav";
}

export function mapVolcengineFileError(httpStatus: number, statusCode: string, detail: string): string {
  const suffix = detail.trim() ? `（${detail.trim()}）` : "";
  if (httpStatus === 401 || httpStatus === 403 || statusCode.startsWith("45")) {
    return `火山录音文件识别鉴权或权限失败，请确认 API Key 已开通 volc.seedasr.auc${suffix}`;
  }
  if (httpStatus === 413) return "火山录音文件识别拒绝了过大的文件，请压缩后重试。";
  if (httpStatus === 429) return `火山录音文件识别调用频率或额度受限，请稍后重试${suffix}`;
  return `火山录音文件识别失败（HTTP ${httpStatus || "未知"}，状态码 ${statusCode || "未知"}）${suffix}`;
}
