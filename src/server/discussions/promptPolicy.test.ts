import { describe, expect, it } from "vitest";
import type { DiscussionDetailDto, UtteranceDto } from "../../shared/types";
import { buildDiscussionTurnPrompt, buildInitialDiscussionPrompt } from "./promptPolicy";

describe("prompt policy", () => {
  it("builds an initialization prompt from background and participants", () => {
    const prompt = buildInitialDiscussionPrompt({
      background: "讨论项目 MVP 如何启动。",
      projectPath: "/tmp/project",
      participants: [{ displayName: "参与人 A" }, { displayName: "参与人 B" }],
      mode: "real",
      title: "不应展示",
      topic: "不应展示"
    });

    expect(prompt).toContain("讨论背景：讨论项目 MVP 如何启动。");
    expect(prompt).toContain("1. 参与人 A");
    expect(prompt).toContain("2. 参与人 B");
    expect(prompt).not.toContain("不应展示");
  });

  it("builds AI advisor prompts with only new transcript as meeting content", () => {
    const discussion = discussionDetail();
    const prompt = buildDiscussionTurnPrompt(discussion, [
      utterance({ participantId: "p1", speakerLabel: "speaker_0", text: "我觉得先验证高频讨论场景。" }),
      utterance({ speakerLabel: "speaker_1", text: "需要先确认转写质量。" })
    ]);

    expect(prompt).toContain("你是会议中的 AI 参谋");
    expect(prompt).toContain("【本次新增对话】");
    expect(prompt).toContain("参与人 A: 我觉得先验证高频讨论场景。");
    expect(prompt).toContain("speaker_1: 需要先确认转写质量。");
    expect(prompt).not.toContain("讨论标题");
    expect(prompt).not.toContain("AI 发言类型");
    expect(prompt).not.toContain("框架");
  });

  it("adds optional host guidance only when the host provides it", () => {
    const discussion = discussionDetail();
    const utterances = [utterance({ text: "我们正在讨论一份合作合同。" })];
    const openPrompt = buildDiscussionTurnPrompt(discussion, utterances);
    const guidedPrompt = buildDiscussionTurnPrompt(
      discussion,
      utterances,
      "",
      "只分析合同风险，并给出需要追问的问题。"
    );

    expect(openPrompt).not.toContain("主持人本轮引导");
    expect(guidedPrompt).toContain("【主持人本轮引导】");
    expect(guidedPrompt).toContain("只分析合同风险，并给出需要追问的问题。");
    expect(guidedPrompt).toContain("请优先直接回应这项引导");
  });
});

function discussionDetail(): DiscussionDetailDto {
  return {
    id: "discussion-1",
    title: "标题",
    topic: "主题",
    projectPath: "/tmp/project",
    mode: "real",
    status: "active",
    createdAt: "2026-05-29T00:00:00.000Z",
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

function utterance(input: Partial<UtteranceDto>): UtteranceDto {
  return {
    id: input.id ?? "utterance-1",
    discussionId: "discussion-1",
    speakerLabel: input.speakerLabel ?? "speaker_0",
    participantId: input.participantId,
    text: input.text ?? "内容",
    isFinal: true,
    source: "volcengine",
    createdAt: "2026-05-29T00:00:00.000Z"
  };
}
