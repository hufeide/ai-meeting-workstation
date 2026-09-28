import express from "express";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FunasrFileTranscriber } from "../asr/funasrFile";
import type { VolcengineFileTranscriber } from "../asr/volcengineFile";
import type { MockAsrService } from "../asr/mockAsr";
import { BrainProviderRegistry } from "../codex/brainRegistry";
import { MockCodexProvider } from "../codex/mockCodex";
import { TruncatedAiResponseError, type CodexProvider } from "../codex/provider";
import { openDatabase } from "../db/database";
import { MemoryStore } from "../memory/memoryStore";
import { LocalSettingsStore } from "../settings/localSettings";
import { EventHub } from "../ws/eventHub";
import { DiscussionRepository } from "./repository";
import { createDiscussionRouter } from "./routes";

let tempDir: string;
let server: Server;
let baseUrl: string;
let mockAsrStarts: string[];
let repository: DiscussionRepository;
let codexProvider: CodexProvider;

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "discussion-routes-"));
  mockAsrStarts = [];

  const db = openDatabase(join(tempDir, "test.db"));
  repository = new DiscussionRepository(db);
  const storagePaths = {
    dataDir: tempDir,
    databasePath: join(tempDir, "test.db"),
    discussionsDir: join(tempDir, "discussions")
  };
  const settingsStore = new LocalSettingsStore(storagePaths);
  const memoryStore = new MemoryStore(storagePaths);
  codexProvider = new MockCodexProvider();
  const brainRegistry = {
    getProvider: () => codexProvider
  } as unknown as BrainProviderRegistry;
  const app = express();
  app.use(express.json());
  app.use(
    "/api/discussions",
    createDiscussionRouter({
      repository,
      brainRegistry,
      settingsStore,
      memoryStore,
      funasrFileTranscriber: new FunasrFileTranscriber({ repository, storagePaths }),
      getVolcengineFileTranscriber: () =>
        ({
          transcribeUpload: async ({ discussionId }: { discussionId: string }) => {
            repository.addUtterance({
              discussionId,
              speakerLabel: "speaker_0",
              text: "火山文件识别测试结果",
              isFinal: true,
              source: "volcengine-file"
            });
            return { transcript: "火山文件识别测试结果", utteranceCount: 1, transcriptPath: "/tmp/test.txt" };
          }
        }) as unknown as VolcengineFileTranscriber,
      eventHub: new EventHub(),
      storagePaths,
      mockAsr: {
        start: (discussionId: string) => mockAsrStarts.push(discussionId),
        stop: () => undefined
      } as unknown as MockAsrService
    })
  );
  server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server did not start");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  rmSync(tempDir, { recursive: true, force: true });
});

describe("createDiscussionRouter", () => {
  it("routes uploaded audio to Volcengine file recognition for the cloud file mode", async () => {
    const discussion = await createDiscussion("real", "volcengine-file");
    const response = await fetch(`${baseUrl}/api/discussions/${discussion.id}/audio-upload?filename=test.wav`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: Buffer.from("test audio")
    });
    const result = (await response.json()) as { utteranceCount: number; discussion: { utterances: Array<{ source: string; text: string }> } };

    expect(response.status).toBe(201);
    expect(result.utteranceCount).toBe(1);
    expect(result.discussion.utterances).toContainEqual(expect.objectContaining({
      source: "volcengine-file",
      text: "火山文件识别测试结果"
    }));
  });

  it("lists recent discussions with final utterance and AI turn counts", async () => {
    const older = await createDiscussion("mock");
    await new Promise((resolve) => setTimeout(resolve, 2));
    const newer = await createDiscussion("real");
    repository.addUtterance({
      discussionId: newer.id,
      speakerLabel: "speaker_0",
      text: "最终转写",
      isFinal: true,
      source: "mock"
    });
    repository.addUtterance({
      discussionId: newer.id,
      speakerLabel: "speaker_0",
      text: "临时转写",
      isFinal: false,
      source: "mock"
    });
    repository.createCompletedAiTurn({
      discussionId: newer.id,
      codexThreadId: "thread-1",
      prompt: "prompt",
      response: "response"
    });
    repository.endDiscussion(older.id);

    const response = await fetch(`${baseUrl}/api/discussions`);
    const discussions = (await response.json()) as Array<{
      id: string;
      status: string;
      finalUtteranceCount: number;
      aiTurnCount: number;
    }>;

    expect(response.status).toBe(200);
    expect(discussions[0]).toMatchObject({
      id: newer.id,
      status: "active",
      finalUtteranceCount: 1,
      aiTurnCount: 1
    });
    expect(discussions.map((discussion) => discussion.id)).toContain(older.id);
  });

  it("does not start mock ASR for real ASR discussions", async () => {
    const discussion = await createDiscussion("real");

    expect(discussion.mode).toBe("real");
    expect(mockAsrStarts).toEqual([]);
  });

  it("defaults new discussions to real ASR without starting mock ASR", async () => {
    const discussion = await createDiscussion();

    expect(discussion.mode).toBe("real");
    expect(mockAsrStarts).toEqual([]);
  });

  it("does not auto-start mock ASR for legacy mock-mode payloads", async () => {
    const discussion = await createDiscussion("mock");

    expect(discussion.mode).toBe("mock");
    expect(mockAsrStarts).toEqual([]);
  });

  it("creates AI turns from the simplified invitation payload", async () => {
    const discussion = await createDiscussion("mock");
    repository.addUtterance({
      discussionId: discussion.id,
      speakerLabel: "speaker_0",
      text: "我们先用手动邀请。",
      isFinal: true,
      source: "mock"
    });
    const response = await fetch(`${baseUrl}/api/discussions/${discussion.id}/ai-turns`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contextMode: "since_last_ai_turn",
        guidance: "只判断当前方案的主要风险。"
      })
    });
    const aiTurn = (await response.json()) as { turnType: string; prompt: string };

    expect(response.status).toBe(201);
    expect(aiTurn.turnType).toBe("next_step");
    expect(aiTurn.prompt).toContain("speaker_0: 我们先用手动邀请。");
    expect(aiTurn.prompt).toContain("AI 参谋");
    expect(aiTurn.prompt).toContain("只判断当前方案的主要风险。");
    expect(aiTurn.prompt).not.toContain("AI 发言类型");
  });

  it("keeps a truncated response and does not resend its processed utterances", async () => {
    const observedBatches: string[][] = [];
    let attempt = 0;
    codexProvider = {
      createThread: async () => "truncated-thread",
      buildPrompt: (input) => input.utterances.map((utterance) => utterance.text).join("\n"),
      respond: async (input) => {
        observedBatches.push(input.utterances.map((utterance) => utterance.text));
        attempt += 1;
        if (attempt === 1) throw new TruncatedAiResponseError("第一轮已生成的有效内容。");
        return "第二轮完整回复。";
      },
      completePrompt: async () => {
        throw new Error("本测试不调用 completePrompt");
      }
    };
    const discussion = await createDiscussion("real");
    const first = repository.addUtterance({
      discussionId: discussion.id,
      speakerLabel: "speaker_0",
      text: "第一批已经被 AI 看过的转写。",
      isFinal: true,
      source: "funasr"
    });

    const firstResponse = await fetch(`${baseUrl}/api/discussions/${discussion.id}/ai-turns`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contextMode: "since_last_ai_turn" })
    });
    const firstAiTurn = (await firstResponse.json()) as {
      status: string;
      response?: string;
      triggerEndUtteranceId?: string;
    };
    repository.addUtterance({
      discussionId: discussion.id,
      speakerLabel: "speaker_1",
      text: "第二批新增转写。",
      isFinal: true,
      source: "funasr"
    });
    const secondResponse = await fetch(`${baseUrl}/api/discussions/${discussion.id}/ai-turns`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contextMode: "since_last_ai_turn" })
    });
    const secondAiTurn = (await secondResponse.json()) as { status: string; response?: string };

    expect(firstResponse.status).toBe(201);
    expect(firstAiTurn).toMatchObject({
      status: "truncated",
      response: "第一轮已生成的有效内容。",
      triggerEndUtteranceId: first.id
    });
    expect(secondResponse.status).toBe(201);
    expect(secondAiTurn).toMatchObject({ status: "completed", response: "第二轮完整回复。" });
    expect(observedBatches).toEqual([
      ["第一批已经被 AI 看过的转写。"],
      ["第二批新增转写。"]
    ]);
  });

  it("does not advance the utterance cursor after a real AI failure", async () => {
    const observedBatches: string[][] = [];
    let attempt = 0;
    codexProvider = {
      createThread: async () => "failed-thread",
      buildPrompt: (input) => input.utterances.map((utterance) => utterance.text).join("\n"),
      respond: async (input) => {
        observedBatches.push(input.utterances.map((utterance) => utterance.text));
        attempt += 1;
        if (attempt === 1) throw new Error("构造的网络错误");
        return "重试后成功。";
      },
      completePrompt: async () => {
        throw new Error("本测试不调用 completePrompt");
      }
    };
    const discussion = await createDiscussion("real");
    repository.addUtterance({
      discussionId: discussion.id,
      speakerLabel: "speaker_0",
      text: "失败后必须重试的第一批转写。",
      isFinal: true,
      source: "funasr"
    });

    const failedResponse = await fetch(`${baseUrl}/api/discussions/${discussion.id}/ai-turns`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contextMode: "since_last_ai_turn" })
    });
    repository.addUtterance({
      discussionId: discussion.id,
      speakerLabel: "speaker_1",
      text: "失败之后新增的第二批转写。",
      isFinal: true,
      source: "funasr"
    });
    const retryResponse = await fetch(`${baseUrl}/api/discussions/${discussion.id}/ai-turns`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contextMode: "since_last_ai_turn" })
    });

    expect(failedResponse.status).toBe(503);
    expect(retryResponse.status).toBe(201);
    expect(observedBatches).toEqual([
      ["失败后必须重试的第一批转写。"],
      ["失败后必须重试的第一批转写。", "失败之后新增的第二批转写。"]
    ]);
  });

  it("exports readable markdown and a zip discussion package", async () => {
    const discussion = await createDiscussion("real");
    repository.addUtterance({
      discussionId: discussion.id,
      speakerLabel: "speaker_0",
      text: "这是一条最终转写。",
      isFinal: true,
      source: "volcengine"
    });
    repository.createCompletedAiTurn({
      discussionId: discussion.id,
      codexThreadId: "thread-1",
      prompt: "speaker_0: 这是一条最终转写。",
      response: "可以继续验证导出。"
    });
    repository.createTruncatedAiTurn({
      discussionId: discussion.id,
      codexThreadId: "thread-1",
      prompt: "speaker_0: 这是一条最终转写。",
      response: "这是已经生成但未完整的建议。"
    });

    const markdownResponse = await fetch(`${baseUrl}/api/discussions/${discussion.id}/export/markdown`);
    const markdown = await markdownResponse.text();
    const packageResponse = await fetch(`${baseUrl}/api/discussions/${discussion.id}/export/package`);
    const packageBuffer = Buffer.from(await packageResponse.arrayBuffer());

    expect(markdownResponse.status).toBe(200);
    expect(markdown).toContain("# 讨论复盘");
    expect(markdown).toContain("这是一条最终转写。");
    expect(markdown).toContain("Codex");
    expect(markdown).toContain("这是已经生成但未完整的建议。");
    expect(markdown).toContain("系统提示：本次回复未完整生成，后续内容因长度限制未生成。");
    expect(packageResponse.status).toBe(200);
    expect(packageResponse.headers.get("content-type")).toContain("application/zip");
    expect(packageBuffer.subarray(0, 4).toString("hex")).toBe("504b0304");
    expect(packageBuffer.toString("utf8")).toContain("manifest.json");
    expect(packageBuffer.toString("utf8")).toContain("discussion.json");
  });

  it("deletes audio assets without deleting transcript data", async () => {
    const discussion = await createDiscussion("real");
    const discussionDir = join(tempDir, "discussions", discussion.id);
    mkdirSync(discussionDir, { recursive: true });
    const audioPath = join(discussionDir, "audio.wav");
    writeFileSync(audioPath, "audio");
    repository.createAudioAsset({
      discussionId: discussion.id,
      path: audioPath,
      format: "wav",
      source: "browser"
    });
    repository.addUtterance({
      discussionId: discussion.id,
      speakerLabel: "speaker_0",
      text: "保留转写。",
      isFinal: true,
      source: "volcengine"
    });

    const response = await fetch(`${baseUrl}/api/discussions/${discussion.id}/audio`, { method: "DELETE" });
    const updated = (await response.json()) as { audioAssets: unknown[]; utterances: unknown[] };

    expect(response.status).toBe(200);
    expect(updated.audioAssets).toHaveLength(0);
    expect(updated.utterances).toHaveLength(1);
    expect(existsSync(audioPath)).toBe(false);
  });

  it("deletes a discussion and its local files", async () => {
    const discussion = await createDiscussion("real");
    const discussionDir = join(tempDir, "discussions", discussion.id);
    mkdirSync(discussionDir, { recursive: true });
    writeFileSync(join(discussionDir, "raw-asr-events.ndjson"), "{}");

    const response = await fetch(`${baseUrl}/api/discussions/${discussion.id}`, { method: "DELETE" });
    const payload = (await response.json()) as { deleted: boolean };

    expect(response.status).toBe(200);
    expect(payload.deleted).toBe(true);
    expect(repository.getDiscussion(discussion.id)).toBeNull();
    expect(existsSync(discussionDir)).toBe(false);
  });
});

async function createDiscussion(mode?: "mock" | "real", asrProvider?: "volcengine-file") {
  const payload = {
    background: "验证 ASR 模式",
    projectPath: tempDir,
    participants: [{ displayName: "参与人 A" }, { displayName: "参与人 B" }],
    ...(mode ? { mode } : {}),
    ...(asrProvider ? { asrProvider } : {})
  };
  const response = await fetch(`${baseUrl}/api/discussions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  expect(response.status).toBe(201);
  return (await response.json()) as { id: string; mode: "mock" | "real" };
}
