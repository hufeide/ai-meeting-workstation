import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "better-sqlite3";
import { openDatabase } from "../db/database";
import { DiscussionRepository } from "./repository";

let tempDir: string;
let db: Database;
let repository: DiscussionRepository;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "ai-discussion-"));
  db = openDatabase(join(tempDir, "test.db"));
  repository = new DiscussionRepository(db);
});

afterEach(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("DiscussionRepository", () => {
  it("creates a discussion with participants and a Codex thread id", () => {
    const discussion = repository.createDiscussion(
      {
        title: "MVP 讨论",
        topic: "验证 mock workflow",
        background: "验证 mock workflow",
        projectPath: "/tmp/project",
        participants: [{ displayName: "参与人 A" }, { displayName: "参与人 B" }],
        mode: "mock"
      },
      "mock-thread-1"
    );

    expect(discussion.status).toBe("active");
    expect(discussion.codexThreadId).toBe("mock-thread-1");
    expect(discussion.participants.map((participant) => participant.displayName)).toEqual(["参与人 A", "参与人 B"]);
  });

  it("binds speaker labels back onto existing utterances", () => {
    const discussion = repository.createDiscussion(
      {
        title: "说话人绑定",
        topic: "验证 speaker label",
        background: "验证 speaker label",
        projectPath: "/tmp/project",
        participants: [{ displayName: "参与人 A" }, { displayName: "参与人 B" }],
        mode: "mock"
      },
      "mock-thread-2"
    );
    const speaker = discussion.participants[1];

    repository.addUtterance({
      discussionId: discussion.id,
      speakerLabel: "speaker_1",
      text: "结束后还要能回到 Codex 继续工作。",
      isFinal: true,
      source: "mock"
    });
    repository.bindSpeaker(discussion.id, {
      speakerLabel: "speaker_1",
      participantId: speaker.id
    });

    const restored = repository.getDiscussionOrThrow(discussion.id);
    expect(restored.speakerBindings).toHaveLength(1);
    expect(restored.utterances[0].participantId).toBe(speaker.id);
  });

  it("returns only final utterances after the last completed AI turn", () => {
    const discussion = repository.createDiscussion(
      {
        title: "AI 触发",
        topic: "验证上下文窗口",
        background: "验证上下文窗口",
        projectPath: "/tmp/project",
        participants: [{ displayName: "参与人 A" }, { displayName: "参与人 B" }],
        mode: "mock"
      },
      "mock-thread-3"
    );

    const first = repository.addUtterance({
      discussionId: discussion.id,
      speakerLabel: "speaker_0",
      text: "先把流程跑通。",
      isFinal: true,
      source: "mock"
    });
    repository.createCompletedAiTurn({
      discussionId: discussion.id,
      turnType: "summary",
      codexThreadId: "mock-thread-3",
      prompt: "第一轮 prompt",
      response: "第一轮回复",
      triggerStartUtteranceId: first.id,
      triggerEndUtteranceId: first.id
    });
    repository.addUtterance({
      discussionId: discussion.id,
      speakerLabel: "speaker_1",
      text: "这条 partial 不应该进入 Codex 上下文。",
      isFinal: false,
      source: "mock"
    });
    const second = repository.addUtterance({
      discussionId: discussion.id,
      speakerLabel: "speaker_1",
      text: "下一步验证一次真实讨论。",
      isFinal: true,
      source: "mock"
    });

    expect(repository.listFinalUtterancesSinceLastAiTurn(discussion.id).map((utterance) => utterance.id)).toEqual([second.id]);
    expect(repository.getDiscussionOrThrow(discussion.id).aiTurns[0]?.turnType).toBe("summary");
  });

  it("treats a truncated AI turn as an utterance cursor boundary", () => {
    const discussion = repository.createDiscussion(
      {
        title: "AI 截断边界",
        topic: "验证截断后不重复发送",
        background: "验证截断后不重复发送",
        projectPath: "/tmp/project",
        participants: [{ displayName: "参与人 A" }, { displayName: "参与人 B" }],
        mode: "mock"
      },
      "mock-thread-truncated"
    );
    const first = repository.addUtterance({
      discussionId: discussion.id,
      speakerLabel: "speaker_0",
      text: "第一批转写。",
      isFinal: true,
      source: "mock"
    });
    repository.createTruncatedAiTurn({
      discussionId: discussion.id,
      codexThreadId: "mock-thread-truncated",
      prompt: "第一轮 prompt",
      response: "第一轮部分回复",
      triggerStartUtteranceId: first.id,
      triggerEndUtteranceId: first.id
    });
    const second = repository.addUtterance({
      discussionId: discussion.id,
      speakerLabel: "speaker_1",
      text: "第二批转写。",
      isFinal: true,
      source: "mock"
    });

    expect(repository.listFinalUtterancesSinceLastAiTurn(discussion.id).map((utterance) => utterance.id)).toEqual([second.id]);
    expect(repository.listDiscussionSummaries()[0]?.aiTurnCount).toBe(1);
  });
});
