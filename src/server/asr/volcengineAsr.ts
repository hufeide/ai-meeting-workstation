import { randomUUID } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import WebSocket from "ws";
import type { ServerConfig } from "../config/serverConfig";
import { rawPayloadIfSmall, summarizePayload, type AsrEventLogEntry } from "./asrEventLog";
import type { AsrProvider, AsrProviderStartInput, TranscriptCandidate } from "./asrProvider";

export class VolcengineAsrProvider implements AsrProvider {
  constructor(private readonly config: ServerConfig["volcengineAsr"]) {}

  checkCredentials(): ReturnType<AsrProvider["checkCredentials"]> {
    const missing = [
      ["VOLCENGINE_ASR_API_KEY", this.config.apiKey],
      ["VOLCENGINE_ASR_RESOURCE_ID", this.config.resourceId]
    ]
      .filter(([, value]) => !value)
      .map(([key]) => key);

    if (missing.length > 0) {
      return {
        ok: false,
        message: `缺少火山 ASR 凭证：${missing.join(", ")}。请在 .env 中配置后再启用真实 ASR。`
      };
    }

    return { ok: true };
  }

  getEndpoint(): string {
    return this.config.endpoint;
  }

  createHandshakeHeaders(connectId: string = randomUUID()): Record<string, string> {
    const credentialCheck = this.checkCredentials();
    if (!credentialCheck.ok) {
      throw new Error(credentialCheck.message);
    }

    return {
      "X-Api-Key": this.config.apiKey!,
      "X-Api-Resource-Id": this.config.resourceId!,
      "X-Api-Connect-Id": connectId
    };
  }

  async startSession(input: AsrProviderStartInput): Promise<VolcengineAsrSession> {
    const connectId = randomUUID();
    const socket = new WebSocket(this.getEndpoint(), {
      headers: this.createHandshakeHeaders(connectId)
    });

    const session = new VolcengineAsrSession(socket, connectId, input);
    await session.open();
    session.sendFullClientRequest(input.discussionId);
    return session;
  }
}

class VolcengineAsrSession {
  private sequence = 1;
  private readonly finalKeys = new Set<string>();

  constructor(
    private readonly socket: WebSocket,
    private readonly connectId: string,
    private readonly callbacks: {
      discussionId: string;
      onPartial: (utterance: TranscriptCandidate) => void;
      onFinal: (utterance: TranscriptCandidate) => void;
      onError: (message: string) => void;
      onLog?: (entry: Omit<AsrEventLogEntry, "timestamp">) => void;
    }
  ) {
    socket.once("upgrade", (response) => {
      this.log("server", "handshake", {
        logId: readHeader(response.headers["x-tt-logid"]),
        payloadSummary: `status ${response.statusCode ?? "unknown"}`,
        rawPayload: response.statusCode ? { statusCode: response.statusCode } : undefined
      });
    });
    socket.on("message", (data) => {
      try {
        this.handleMessage(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
      } catch (error) {
        this.callbacks.onError(error instanceof Error ? error.message : "解析火山 ASR 返回失败。");
      }
    });
    socket.on("error", (error) => {
      this.log("server", "failed", {
        payloadSummary: error.message,
        rawPayload: { message: error.message }
      });
      this.callbacks.onError(`火山 ASR 连接失败：${error.message}`);
    });
    socket.on("close", (code, reason) => {
      this.log("server", "closed", {
        payloadSummary: `code ${code}`,
        rawPayload: {
          code,
          reason: reason.toString("utf8")
        }
      });
    });
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("火山 ASR 建连超时。")), 10000);
      this.socket.once("open", () => {
        clearTimeout(timeout);
        resolve();
      });
      this.socket.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  sendFullClientRequest(discussionId: string): void {
    const requestPayload = {
      user: { uid: discussionId },
      audio: {
        format: "pcm",
        codec: "raw",
        rate: 16000,
        bits: 16,
        channel: 1
      },
      request: {
        model_name: "bigmodel",
        enable_nonstream: true,
        enable_itn: true,
        enable_punc: true,
        enable_ddc: false,
        enable_speaker_info: true,
        ssd_version: "200",
        show_utterances: true,
        result_type: "full"
      }
    };
    this.log("client", "full_client_request", {
      payloadSummary: summarizePayload(requestPayload),
      rawPayload: requestPayload
    });
    this.socket.send(
      createFrame({
        messageType: 1,
        flags: 0,
        serialization: 1,
        compression: 1,
        payload: Buffer.from(JSON.stringify(requestPayload))
      })
    );
  }

  sendAudio(chunk: Buffer): void {
    if (this.socket.readyState !== WebSocket.OPEN) return;
    this.log("client", "audio_chunk", {
      payloadSummary: `${chunk.byteLength} bytes, sequence ${this.sequence}`
    });
    this.socket.send(
      createFrame({
        messageType: 2,
        flags: 0,
        serialization: 0,
        compression: 1,
        payload: chunk
      })
    );
    this.sequence += 1;
  }

  close(): void {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.log("client", "close_request", {
        payloadSummary: "end audio stream"
      });
      this.socket.send(
        createFrame({
          messageType: 2,
          flags: 2,
          serialization: 0,
          compression: 1,
          payload: Buffer.alloc(0)
        })
      );
      this.socket.close();
    }
  }

  private handleMessage(frame: Buffer): void {
    const parsed = parseFrame(frame);
    if (parsed.messageType === 15) {
      this.log("server", "error_frame", {
        payloadSummary: parsed.errorMessage ?? "vendor error",
        rawPayload: {
          code: parsed.errorCode,
          message: parsed.errorDetail
        }
      });
      this.callbacks.onError(parsed.errorMessage ?? "火山 ASR 返回错误。");
      return;
    }
    if (parsed.messageType !== 9 || !parsed.payload) return;

    const payload = JSON.parse(parsed.payload.toString("utf8")) as VolcengineResponse;
    this.log("server", "result_frame", {
      payloadSummary: summarizeVolcengineResponse(payload),
      rawPayload: rawPayloadIfSmall(payload)
    });
    const utterances = normalizeUtterances(payload);
    if (utterances.length === 0 && payload.result?.text) {
      this.callbacks.onPartial({
        speakerLabel: "speaker_0",
        text: payload.result.text
      });
      return;
    }

    for (const utterance of utterances) {
      const key = `${utterance.speakerLabel}:${utterance.startMs ?? ""}:${utterance.endMs ?? ""}:${utterance.text}`;
      if (utterance.isFinal) {
        if (this.finalKeys.has(key)) continue;
        this.finalKeys.add(key);
        this.callbacks.onFinal(utterance);
      } else {
        this.callbacks.onPartial(utterance);
      }
    }
  }

  private log(
    direction: AsrEventLogEntry["direction"],
    eventType: string,
    entry: Omit<AsrEventLogEntry, "timestamp" | "direction" | "eventType" | "requestId">
  ): void {
    this.callbacks.onLog?.({
      direction,
      eventType,
      requestId: this.connectId,
      ...entry
    });
  }
}

type VolcengineResponse = {
  result?: {
    text?: string;
    utterances?: VolcengineUtterance[];
  };
};

export type VolcengineUtterance = {
  text?: string;
  start_time?: number;
  end_time?: number;
  definite?: boolean;
  speaker?: string | number;
  speaker_id?: string | number;
  spk_id?: string | number;
  additions?: unknown;
};

function createFrame(input: {
  messageType: number;
  flags: number;
  serialization: number;
  compression: number;
  payload: Buffer;
}): Buffer {
  const payload = input.compression === 1 ? gzipSync(input.payload) : input.payload;
  const header = Buffer.from([0x11, (input.messageType << 4) | input.flags, (input.serialization << 4) | input.compression, 0x00]);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(payload.byteLength, 0);
  return Buffer.concat([header, size, payload]);
}

function parseFrame(frame: Buffer): { messageType: number; payload?: Buffer; errorCode?: number; errorDetail?: string; errorMessage?: string } {
  if (frame.byteLength < 8) {
    throw new Error("火山 ASR 返回帧过短。");
  }

  const headerSize = (frame[0] & 0x0f) * 4;
  const messageType = frame[1] >> 4;
  const flags = frame[1] & 0x0f;
  const compression = frame[2] & 0x0f;
  let offset = headerSize;

  if (messageType === 15) {
    const code = frame.readUInt32BE(offset);
    offset += 4;
    const size = frame.readUInt32BE(offset);
    offset += 4;
    const detail = frame.subarray(offset, offset + size).toString("utf8");
    return {
      messageType,
      errorCode: code,
      errorDetail: detail,
      errorMessage: mapVolcengineError(code, detail)
    };
  }

  if (flags === 1 || flags === 3) offset += 4;
  const payloadSize = frame.readUInt32BE(offset);
  offset += 4;
  const payload = frame.subarray(offset, offset + payloadSize);
  return {
    messageType,
    payload: compression === 1 ? gunzipSync(payload) : payload
  };
}

function normalizeUtterances(payload: VolcengineResponse) {
  return (payload.result?.utterances ?? [])
    .filter((utterance) => utterance.text)
    .map((utterance) => ({
      speakerLabel: normalizeSpeakerLabel(utterance),
      text: utterance.text!,
      startMs: utterance.start_time,
      endMs: utterance.end_time,
      isFinal: Boolean(utterance.definite)
    }));
}

export function normalizeSpeakerLabel(utterance: VolcengineUtterance): string {
  const speaker =
    utterance.speaker_id ??
    utterance.spk_id ??
    utterance.speaker ??
    readAddition(utterance.additions, "speaker_id") ??
    readAddition(utterance.additions, "spk_id") ??
    readAddition(utterance.additions, "speaker") ??
    readNestedAddition(utterance.additions, ["speaker_info", "speaker_id"]);
  return speaker === undefined || speaker === null || speaker === "" ? "speaker_0" : `speaker_${String(speaker).replace(/^speaker_?/i, "")}`;
}

export function mapVolcengineError(code: number, detail?: string): string {
  const suffix = detail ? `（${detail}）` : "";
  if (code === 401 || code === 403) return `火山 ASR 鉴权失败，请检查 API Key 和 Resource ID${suffix}`;
  if (code === 429) return `火山 ASR 调用频率或额度受限，请稍后重试${suffix}`;
  if (code >= 400 && code < 500) return `火山 ASR 请求参数异常，请检查音频格式和请求配置${suffix}`;
  if (code >= 500) return `火山 ASR 服务异常，请稍后重试${suffix}`;
  return `火山 ASR 返回错误码 ${code}${suffix}`;
}

function readAddition(additions: unknown, key: string): unknown {
  if (!additions) return undefined;
  if (typeof additions === "string") {
    try {
      return readAddition(JSON.parse(additions) as unknown, key);
    } catch {
      return undefined;
    }
  }
  if (typeof additions === "object" && !Array.isArray(additions)) {
    return (additions as Record<string, unknown>)[key];
  }
  return undefined;
}

function readNestedAddition(additions: unknown, path: string[]): unknown {
  let current = additions;
  for (const key of path) {
    current = readAddition(current, key);
  }
  return current;
}

function readHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function summarizeVolcengineResponse(payload: VolcengineResponse): string {
  const utteranceCount = payload.result?.utterances?.length ?? 0;
  const textLength = payload.result?.text?.length ?? 0;
  return `text ${textLength} chars, utterances ${utteranceCount}`;
}
