import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "better-sqlite3";
import type { FunasrFileTranscriber } from "../asr/funasrFile";
import { openDatabase } from "../db/database";
import { DiscussionRepository } from "../discussions/repository";
import { MemoryStore } from "../memory/memoryStore";
import { EventHub } from "../ws/eventHub";
import { createDemoStoragePaths, DEMO_CUSTOMER_ID, DemoWorkspace } from "./demoWorkspace";

let tempDir: string;
let database: Database;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "meeting-demo-workspace-"));
});

afterEach(() => {
  database?.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("DemoWorkspace", () => {
  it("uses a dedicated database, customer directory and discussion directory", () => {
    const basePaths = {
      dataDir: tempDir,
      databasePath: join(tempDir, "app.db"),
      discussionsDir: join(tempDir, "discussions")
    };
    const demoPaths = createDemoStoragePaths(basePaths);

    expect(demoPaths.databasePath).toBe(join(tempDir, "demo", "app.db"));
    expect(demoPaths.discussionsDir).toBe(join(tempDir, "demo", "discussions"));
    expect(demoPaths.databasePath).not.toBe(basePaths.databasePath);
    expect(demoPaths.discussionsDir).not.toBe(basePaths.discussionsDir);
  });

  it("loads fallback audio once and resets only demo data", async () => {
    const realSentinel = join(tempDir, "real-meeting-data.keep");
    const fallbackAudio = join(tempDir, "fallback.wav");
    writeFileSync(realSentinel, "must stay");
    writeFileSync(fallbackAudio, "synthetic audio");

    const demoPaths = createDemoStoragePaths({
      dataDir: tempDir,
      databasePath: join(tempDir, "app.db"),
      discussionsDir: join(tempDir, "discussions")
    });
    database = openDatabase(demoPaths.databasePath);
    const repository = new DiscussionRepository(database);
    const memoryStore = new MemoryStore(demoPaths);
    let transcriptionCount = 0;
    const transcriber = {
      transcribeUpload: async (input: { discussionId: string }) => {
        transcriptionCount += 1;
        repository.addUtterance({
          discussionId: input.discussionId,
          speakerLabel: "speaker_0",
          text: "这是澄远科技的虚构演示录音。",
          isFinal: true,
          source: "funasr"
        });
        return {
          transcript: "这是澄远科技的虚构演示录音。",
          utteranceCount: 1,
          transcriptPath: join(demoPaths.discussionsDir, input.discussionId, "transcript.txt")
        };
      }
    } as unknown as FunasrFileTranscriber;
    const workspace = new DemoWorkspace({
      repository,
      memoryStore,
      funasrFileTranscriber: transcriber,
      eventHub: new EventHub(),
      storagePaths: demoPaths,
      fallbackAudioPath: fallbackAudio
    });

    const bootstrap = workspace.bootstrap();
    const discussion = repository.createDiscussion(
      {
        title: "澄远科技演示会议",
        topic: "经营复盘",
        background: bootstrap.meeting.background,
        projectPath: tempDir,
        customerId: DEMO_CUSTOMER_ID,
        participants: bootstrap.meeting.participants,
        mode: "real",
        asrProvider: "volcengine",
        brainProvider: "mock",
        brainModel: "mock"
      },
      "demo-thread"
    );

    const first = await workspace.loadFallbackAudio(discussion.id);
    const second = await workspace.loadFallbackAudio(discussion.id);

    expect(first.alreadyLoaded).toBe(false);
    expect(second.alreadyLoaded).toBe(true);
    expect(transcriptionCount).toBe(1);
    expect(repository.getDiscussionOrThrow(discussion.id).utterances).toHaveLength(1);

    const reset = workspace.reset();

    expect(repository.listDiscussionSummaries()).toEqual([]);
    expect(memoryStore.listCustomers().map((customer) => customer.id)).toEqual([DEMO_CUSTOMER_ID]);
    expect(reset.customer.displayName).toContain("澄远科技");
    expect(existsSync(realSentinel)).toBe(true);
  });
});
