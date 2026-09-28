import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "node:http";
import { WebSocketServer } from "ws";
import type { DiscussionRepository } from "../discussions/repository";
import type { StoragePaths } from "../storage/paths";
import type { EventHub } from "../ws/eventHub";
import { WavWriter } from "./wavWriter";
import type { UtteranceDto } from "../../shared/types";
import { AsrEventLogger, type AsrEventLogEntry } from "../asr/asrEventLog";
import type { AsrProvider } from "../asr/asrProvider";

export class AudioGateway {
  constructor(
    private readonly deps: {
      repository: DiscussionRepository;
      eventHub: EventHub;
      storagePaths: StoragePaths;
      socketPath?: string;
      getAsrProvider: (discussion: NonNullable<ReturnType<DiscussionRepository["getDiscussion"]>>) => AsrProvider | undefined;
    }
  ) {}

  attach(server: Server): void {
    const wss = new WebSocketServer({ noServer: true });

    server.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "", "http://localhost");
      if (url.pathname !== (this.deps.socketPath ?? "/audio")) return;

      wss.handleUpgrade(request, socket, head, (webSocket) => {
        wss.emit("connection", webSocket, request);
      });
    });

    wss.on("connection", (socket, request) => {
      const url = new URL(request.url ?? "", "http://localhost");
      const discussionId = url.searchParams.get("discussionId");
      const sampleRate = Number(url.searchParams.get("sampleRate") ?? 48000);

      if (!discussionId) {
        socket.close(1008, "discussionId is required");
        return;
      }

      const discussion = this.deps.repository.getDiscussion(discussionId);
      if (!discussion) {
        socket.close(1008, "discussion not found");
        return;
      }

      const discussionDir = join(this.deps.storagePaths.discussionsDir, discussionId);
      mkdirSync(discussionDir, { recursive: true });
      const wavPath = join(discussionDir, `audio-${Date.now()}.wav`);
      const writer = new WavWriter(wavPath, Number.isFinite(sampleRate) ? sampleRate : 48000);
      const asrLog = new AsrEventLogger(join(discussionDir, "raw-asr-events.ndjson"));
      const pendingChunks: Buffer[] = [];
      let asrSession: Awaited<ReturnType<AsrProvider["startSession"]>> | undefined;
      let hasReceivedAsrResult = false;

      const appendLog = (entry: Omit<AsrEventLogEntry, "timestamp">) => asrLog.append(entry);
      appendLog({
        direction: "client",
        eventType: "audio_socket_connected",
        requestId: discussionId,
        payloadSummary: `browser audio websocket, sampleRate ${Number.isFinite(sampleRate) ? sampleRate : 48000}`,
        rawPayload: {
          sampleRate: Number.isFinite(sampleRate) ? sampleRate : 48000
        }
      });

      const asrProvider = this.deps.getAsrProvider(discussion);
      const credentialCheck = asrProvider?.checkCredentials() ?? {
        ok: false as const,
        message:
          discussion.asrProvider === "funasr" || discussion.asrProvider === "volcengine-file"
            ? "当前选择录音文件识别档，不支持麦克风实时流式；请使用“上传录音文件”。"
            : "当前 ASR provider 不支持麦克风实时流式。"
      };
      if (!credentialCheck.ok && discussion.mode === "real") {
        appendLog({
          direction: "server",
          eventType: "failed",
          requestId: discussionId,
          payloadSummary: credentialCheck.message,
          rawPayload: { code: "auth_failed" }
        });
        this.deps.eventHub.publish(discussionId, { type: "asr.status", status: "failed" });
        this.deps.eventHub.publish(discussionId, {
          type: "asr.error",
          code: "auth_failed",
          message: credentialCheck.message,
          retryable: false
        });
      }
      if (discussion.mode === "real" && credentialCheck.ok) {
        appendLog({
          direction: "server",
          eventType: "connecting",
          requestId: discussionId,
          payloadSummary: "opening volcengine websocket"
        });
        this.deps.eventHub.publish(discussionId, { type: "asr.status", status: "connecting" });
        void asrProvider!
          .startSession({
            discussionId,
            onPartial: (utterance) => {
              hasReceivedAsrResult = true;
              appendLog({
                direction: "server",
                eventType: "receiving",
                requestId: discussionId,
                payloadSummary: `partial ${utterance.text.length} chars from ${utterance.speakerLabel}`,
                rawPayload: utterance
              });
              this.deps.eventHub.publish(discussionId, { type: "asr.status", status: "receiving" });
              this.deps.eventHub.publish(discussionId, {
                type: "transcript.partial",
                utterance: createTransientPartialUtterance(discussionId, utterance)
              });
            },
            onFinal: (utterance) => {
              hasReceivedAsrResult = true;
              const saved = this.deps.repository.addUtterance({
                discussionId,
                speakerLabel: utterance.speakerLabel,
                text: utterance.text,
                startMs: utterance.startMs,
                endMs: utterance.endMs,
                isFinal: true,
                source: "volcengine"
              });
              appendLog({
                direction: "server",
                eventType: "receiving",
                requestId: discussionId,
                payloadSummary: `final ${utterance.text.length} chars from ${utterance.speakerLabel}`,
                rawPayload: utterance
              });
              this.deps.eventHub.publish(discussionId, { type: "asr.status", status: "receiving" });
              this.deps.eventHub.publish(discussionId, { type: "transcript.final", utterance: saved });
            },
            onError: (message) => {
              appendLog({
                direction: "server",
                eventType: "failed",
                requestId: discussionId,
                payloadSummary: message,
                rawPayload: { code: "vendor_error" }
              });
              this.deps.eventHub.publish(discussionId, { type: "asr.status", status: "failed" });
              this.deps.eventHub.publish(discussionId, {
                type: "asr.error",
                code: "vendor_error",
                message,
                retryable: true
              });
            },
            onLog: appendLog
          })
          .then((session) => {
            asrSession = session;
            appendLog({
              direction: "server",
              eventType: "connected",
              requestId: discussionId,
              payloadSummary: "volcengine websocket open"
            });
            this.deps.eventHub.publish(discussionId, { type: "asr.status", status: "connected" });
            for (const chunk of pendingChunks.splice(0)) {
              session.sendAudio(chunk);
            }
          })
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : "火山 ASR 建连失败。";
            appendLog({
              direction: "server",
              eventType: "failed",
              requestId: discussionId,
              payloadSummary: message,
              rawPayload: { code: "connection_failed" }
            });
            this.deps.eventHub.publish(discussionId, { type: "asr.status", status: "failed" });
            this.deps.eventHub.publish(discussionId, {
              type: "asr.error",
              code: "connection_failed",
              message,
              retryable: true
            });
          });
      } else if (discussion.mode === "mock") {
        this.deps.eventHub.publish(discussionId, { type: "asr.status", status: "connected" });
      }

      socket.on("message", (data) => {
        if (typeof data === "string") return;
        const chunk = toBuffer(data);
        appendLog({
          direction: "client",
          eventType: "audio_chunk_received",
          requestId: discussionId,
          payloadSummary: `${chunk.byteLength} bytes`
        });
        writer.writePcm16(chunk);
        if (discussion.mode === "real" && credentialCheck.ok) {
          if (asrSession) {
            asrSession.sendAudio(chunk);
          } else {
            pendingChunks.push(chunk);
          }
        }
      });

      socket.on("close", () => {
        asrSession?.close();
        appendLog({
          direction: "server",
          eventType: "closed",
          requestId: discussionId,
          payloadSummary: hasReceivedAsrResult ? "audio socket closed after ASR result" : "audio socket closed before ASR result"
        });
        const saved = writer.close();
        const asset = this.deps.repository.createAudioAsset({
          discussionId,
          path: saved.path,
          format: "wav",
          durationMs: saved.durationMs,
          source: "browser"
        });
        this.deps.eventHub.publish(discussionId, { type: "audio.asset.saved", asset });
        this.deps.eventHub.publish(discussionId, { type: "asr.status", status: "closed" });
      });
    });
  }
}

function toBuffer(data: Buffer | ArrayBuffer | Buffer[]): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (Buffer.isBuffer(data)) return data;
  return Buffer.from(new Uint8Array(data));
}

function createTransientPartialUtterance(
  discussionId: string,
  utterance: Omit<UtteranceDto, "id" | "discussionId" | "createdAt" | "source" | "isFinal"> & { text: string }
): UtteranceDto {
  const segmentKey = utterance.startMs ?? "live";
  return {
    id: `partial:${discussionId}:${utterance.speakerLabel}:${segmentKey}`,
    discussionId,
    speakerLabel: utterance.speakerLabel,
    text: utterance.text,
    startMs: utterance.startMs,
    endMs: utterance.endMs,
    isFinal: false,
    source: "volcengine",
    createdAt: new Date().toISOString()
  };
}
