import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProductEvent } from "../../shared/events";
import type { AsrProvider } from "../asr/asrProvider";
import type { ServerConfig } from "../config/serverConfig";
import { openDatabase } from "../db/database";
import { DiscussionRepository } from "../discussions/repository";
import { ensureStoragePaths } from "../storage/paths";
import { EventHub } from "../ws/eventHub";
import { AudioGateway } from "./audioGateway";

type StartSessionInput = Parameters<AsrProvider["startSession"]>[0];

let tempDir: string;
let server: Server;
let baseUrl: string;
let repository: DiscussionRepository;
let db: ReturnType<typeof openDatabase>;

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "audio-gateway-"));
  const storagePaths = ensureStoragePaths({
    dataDir: tempDir
  } as ServerConfig);
  db = openDatabase(storagePaths.databasePath);
  repository = new DiscussionRepository(db);
  const eventHub = new EventHub();
  const appServer = createServer();
  const audioGateway = new AudioGateway({
    repository,
    eventHub,
    storagePaths,
    getAsrProvider: () => createFakeAsrProvider()
  });

  eventHub.attach(appServer);
  audioGateway.attach(appServer);
  server = appServer;
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server did not start");
  }
  baseUrl = `ws://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("AudioGateway", () => {
  it("publishes repeated ASR partials as one transient utterance and persists only the final result", async () => {
    const discussion = repository.createDiscussion(
      {
        title: "真实 ASR",
        topic: "验证 partial 去重",
        background: "验证 partial 去重",
        projectPath: tempDir,
        mode: "real",
        participants: [{ displayName: "参与人 A" }, { displayName: "参与人 B" }]
      },
      "thread-1"
    );
    const eventSocket = await openSocket(`${baseUrl}/ws?discussionId=${discussion.id}`);
    const events: ProductEvent[] = [];
    const finalEvent = waitForEvent(eventSocket, events, (event) => event.type === "transcript.final");
    const audioSocket = await openSocket(`${baseUrl}/audio?discussionId=${discussion.id}&sampleRate=16000`);

    audioSocket.send(Buffer.alloc(3200));
    await finalEvent;
    const assetEvent = waitForEvent(eventSocket, events, (event) => event.type === "audio.asset.saved");
    audioSocket.close();
    await assetEvent;
    eventSocket.close();

    const partials = events.filter((event) => event.type === "transcript.partial");
    const persisted = repository.getDiscussionOrThrow(discussion.id).utterances;
    const rawAsrLogPath = join(tempDir, "discussions", discussion.id, "raw-asr-events.ndjson");
    const rawAsrEvents = readFileSync(rawAsrLogPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { direction: string; eventType: string; payloadSummary: string });

    expect(partials).toHaveLength(2);
    expect(partials[0].utterance.id).toBe(partials[1].utterance.id);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      text: "我们开始验证真实转写。",
      isFinal: true,
      source: "volcengine"
    });
    expect(existsSync(rawAsrLogPath)).toBe(true);
    expect(rawAsrEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ direction: "client", eventType: "audio_chunk_received" }),
        expect.objectContaining({ direction: "server", eventType: "connecting" }),
        expect.objectContaining({ direction: "server", eventType: "connected" }),
        expect.objectContaining({ direction: "server", eventType: "receiving" }),
        expect.objectContaining({ direction: "server", eventType: "closed" })
      ])
    );
  });
});

function createFakeAsrProvider(): AsrProvider {
  return {
    checkCredentials: () => ({ ok: true }),
    startSession: async (input: StartSessionInput) => {
      let emitted = false;
      return {
        sendAudio: () => {
          if (emitted) return;
          emitted = true;
          input.onPartial({
            speakerLabel: "speaker_0",
            text: "我们开始",
            startMs: 0,
            endMs: 500
          });
          input.onPartial({
            speakerLabel: "speaker_0",
            text: "我们开始验证真实转写。",
            startMs: 0,
            endMs: 1400
          });
          input.onFinal({
            speakerLabel: "speaker_0",
            text: "我们开始验证真实转写。",
            startMs: 0,
            endMs: 1400
          });
        },
        close: () => undefined
      };
    }
  };
}

function openSocket(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function waitForEvent(
  socket: WebSocket,
  events: ProductEvent[],
  predicate: (event: ProductEvent) => boolean
): Promise<ProductEvent> {
  return new Promise((resolve) => {
    socket.on("message", (data) => {
      const event = JSON.parse(data.toString()) as ProductEvent;
      events.push(event);
      if (predicate(event)) {
        resolve(event);
      }
    });
  });
}
