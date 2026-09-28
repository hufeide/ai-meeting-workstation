import { describe, expect, it } from "vitest";
import type { DiscussionDetailDto, UtteranceDto } from "../../shared/types";
import { MockCodexProvider } from "./mockCodex";
import { buildInitialDiscussionPrompt } from "./provider";

describe("MockCodexProvider", () => {
  it("builds the simplified initial prompt with background and participants", () => {
    const prompt = buildInitialDiscussionPrompt({
      background: "我们要讨论 AI 如何参与项目决策。",
      projectPath: "/tmp/project",
      participants: [
        { displayName: "参与人 A" },
        { displayName: "参与人 B" }
      ],
      mode: "mock",
      title: "不应被使用",
      topic: "不应被使用"
    });

    expect(prompt).toContain("你将作为“第三位”讨论者参与一个讨论");
    expect(prompt).toContain("讨论背景：我们要讨论 AI 如何参与项目决策。");
    expect(prompt).toContain("1. 参与人 A");
    expect(prompt).toContain("2. 参与人 B");
    expect(prompt).toContain("不要无脑附和观点");
    expect(prompt).toContain("请只回复一句简短确认");
    expect(prompt).not.toContain("讨论标题");
    expect(prompt).not.toContain("讨论主题");
  });

  it("builds an invitation prompt with speaker names and final transcripts under the meeting advisor policy", () => {
    const provider = new MockCodexProvider();
    const discussion: DiscussionDetailDto = {
      id: "discussion-1",
      title: "项目增长策略讨论",
      topic: "验证 AI 作为第三位讨论者的最小闭环",
      background: "需要说话人区分和手动触发。",
      projectPath: "/tmp/project",
      mode: "mock",
      codexThreadId: "mock-thread-1",
      status: "active",
      createdAt: "2026-05-27T00:00:00.000Z",
      startedAt: "2026-05-27T00:00:00.000Z",
      participants: [
        { id: "p1", discussionId: "discussion-1", displayName: "参与人 A", sortOrder: 0 },
        { id: "p2", discussionId: "discussion-1", displayName: "参与人 B", sortOrder: 1 }
      ],
      speakerBindings: [],
      utterances: [],
      aiTurns: [],
      audioAssets: []
    };
    const utterances: UtteranceDto[] = [
      {
        id: "u1",
        discussionId: "discussion-1",
        speakerLabel: "speaker_0",
        participantId: "p1",
        text: "先做手动触发。",
        isFinal: true,
        source: "mock",
        createdAt: "2026-05-27T00:00:01.000Z"
      },
      {
        id: "u2",
        discussionId: "discussion-1",
        speakerLabel: "speaker_1",
        participantId: "p2",
        text: "要保证结束后能回到 Codex。",
        isFinal: true,
        source: "mock",
        createdAt: "2026-05-27T00:00:02.000Z"
      }
    ];

    const prompt = provider.buildPrompt({ discussion, utterances });

    expect(prompt).toContain("你是会议中的 AI 参谋");
    expect(prompt).toContain("参与人 A: 先做手动触发。");
    expect(prompt).toContain("参与人 B: 要保证结束后能回到 Codex。");
    expect(prompt).not.toContain("讨论标题");
    expect(prompt).not.toContain("讨论主题");
    expect(prompt).not.toContain("背景");
    expect(prompt).not.toContain("AI 发言类型");
  });

  it("uses a minimal empty-transcript prompt when there is no new final transcript", () => {
    const provider = new MockCodexProvider();

    const prompt = provider.buildPrompt({ discussion: createDiscussion(), utterances: [] });
    expect(prompt).toContain("当前还没有新的转写内容。");
    expect(prompt).toContain("你是会议中的 AI 参谋");
  });

  it("returns one natural mock response without focused turn types", async () => {
    const provider = new MockCodexProvider();
    const discussion = createDiscussion();
    const utterances = [
      {
        id: "u1",
        discussionId: discussion.id,
        speakerLabel: "speaker_0",
        text: "先做手动触发。",
        isFinal: true,
        source: "mock" as const,
        createdAt: "2026-05-27T00:00:01.000Z"
      }
    ];

    await expect(provider.respond({ discussion, utterances })).resolves.toContain("AI 介入方式");
  });
});

function createDiscussion(): DiscussionDetailDto {
  return {
    id: "discussion-1",
    title: "项目增长策略讨论",
    topic: "验证 AI 作为第三位讨论者的最小闭环",
    background: "需要说话人区分和手动触发。",
    projectPath: "/tmp/project",
    mode: "mock",
    codexThreadId: "mock-thread-1",
    status: "active",
    createdAt: "2026-05-27T00:00:00.000Z",
    startedAt: "2026-05-27T00:00:00.000Z",
    participants: [
      { id: "p1", discussionId: "discussion-1", displayName: "参与人 A", sortOrder: 0 },
      { id: "p2", discussionId: "discussion-1", displayName: "参与人 B", sortOrder: 1 }
    ],
    speakerBindings: [],
    utterances: [],
    aiTurns: [],
    audioAssets: []
  };
}
