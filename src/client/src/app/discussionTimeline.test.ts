import { describe, expect, it } from "vitest";
import type { AiTurnDto, DiscussionDetailDto, SpeakerBindingDto, UtteranceDto } from "../../../shared/types";
import { buildDiscussionTimeline, buildVisibleDiscussionTimeline, mergeAiTurn, mergeUtterance, unboundSpeakerLabels } from "./discussionTimeline";

describe("discussion timeline state", () => {
  it("clears a same-speaker partial when the final utterance arrives", () => {
    const partial = utterance({ id: "u-partial", speakerLabel: "speaker_0", text: "临时", isFinal: false });
    const final = utterance({ id: "u-final", speakerLabel: "speaker_0", text: "最终", isFinal: true });
    const discussion = discussionDetail({ utterances: [partial] });

    const nextDiscussion = mergeUtterance(discussion, final);

    expect(nextDiscussion?.utterances).toEqual([final]);
  });

  it("inserts completed Codex turns into the discussion timeline by completion time", () => {
    const discussion = discussionDetail({
      utterances: [
        utterance({ id: "u-1", text: "第一句", createdAt: "2026-05-28T10:00:00.000Z" }),
        utterance({ id: "u-2", text: "第二句", createdAt: "2026-05-28T10:02:00.000Z" })
      ],
      aiTurns: [
        aiTurn({
          id: "ai-1",
          response: "Codex 发言",
          createdAt: "2026-05-28T09:59:00.000Z",
          completedAt: "2026-05-28T10:01:00.000Z"
        })
      ]
    });

    expect(buildDiscussionTimeline(discussion).map((item) => item.id)).toEqual(["u-1", "ai-1", "u-2"]);
  });

  it("keeps a truncated AI response visible in the discussion timeline", () => {
    const discussion = discussionDetail({
      aiTurns: [aiTurn({ id: "ai-truncated", status: "truncated", response: "已经生成的部分建议。" })]
    });

    expect(buildDiscussionTimeline(discussion).map((item) => item.id)).toEqual(["ai-truncated"]);
  });

  it("places a completed AI turn after its FunASR trigger boundary", () => {
    const discussion = discussionDetail({
      startedAt: "2026-05-28T10:00:00.000Z",
      utterances: [
        utterance({ id: "u-1", source: "funasr", startMs: 0 }),
        utterance({ id: "u-2", source: "funasr", startMs: 120_000 })
      ],
      aiTurns: [
        aiTurn({
          id: "ai-1",
          triggerEndUtteranceId: "u-2",
          completedAt: "2026-05-28T10:01:00.000Z"
        })
      ]
    });

    expect(buildDiscussionTimeline(discussion).map((item) => item.id)).toEqual(["u-1", "u-2", "ai-1"]);
  });

  it("orders ASR utterances by their spoken timestamp instead of delayed arrival time", () => {
    const discussion = discussionDetail({
      startedAt: "2026-05-28T10:00:00.000Z",
      utterances: [
        utterance({ id: "u-late-arrival", startMs: 149_000, createdAt: "2026-05-28T10:03:00.000Z" }),
        utterance({ id: "u-latest-spoken", startMs: 156_000, createdAt: "2026-05-28T10:02:40.000Z" }),
        utterance({ id: "u-first-spoken", startMs: 145_000, createdAt: "2026-05-28T10:03:10.000Z" })
      ]
    });

    expect(buildDiscussionTimeline(discussion).map((item) => item.id)).toEqual([
      "u-first-spoken",
      "u-late-arrival",
      "u-latest-spoken"
    ]);
  });

  it("keeps speaker binding prompts only for unbound labels", () => {
    const discussion = discussionDetail({
      speakerBindings: [speakerBinding({ speakerLabel: "speaker_0" })],
      utterances: [
        utterance({ id: "u-1", speakerLabel: "speaker_0" }),
        utterance({ id: "u-2", speakerLabel: "speaker_1" })
      ]
    });

    expect(unboundSpeakerLabels(discussion)).toEqual(["speaker_1"]);
  });

  it("merges Codex turns without duplicating completed events", () => {
    const discussion = discussionDetail({
      aiTurns: [aiTurn({ id: "ai-1", response: "旧回复" })]
    });

    const nextDiscussion = mergeAiTurn(discussion, aiTurn({ id: "ai-1", response: "新回复" }));

    expect(nextDiscussion?.aiTurns).toHaveLength(1);
    expect(nextDiscussion?.aiTurns[0]?.response).toBe("新回复");
  });

  it("adds a temporary Codex thinking row while an AI invitation is pending", () => {
    const discussion = discussionDetail({
      utterances: [utterance({ id: "u-1", text: "邀请 AI 看看。" })]
    });

    const timeline = buildVisibleDiscussionTimeline(discussion, { isInvitingCodex: true });

    expect(timeline.map((item) => item.type)).toEqual(["utterance", "codexPending"]);
  });
});

function discussionDetail(input: Partial<DiscussionDetailDto> = {}): DiscussionDetailDto {
  return {
    id: "discussion-1",
    title: "讨论",
    topic: "主题",
    projectPath: "/tmp/project",
    mode: "mock",
    status: "active",
    createdAt: "2026-05-28T09:58:00.000Z",
    participants: [
      {
        id: "participant-1",
        discussionId: "discussion-1",
        displayName: "参与人 A",
        sortOrder: 0
      }
    ],
    speakerBindings: [],
    utterances: [],
    aiTurns: [],
    audioAssets: [],
    ...input
  };
}

function utterance(input: Partial<UtteranceDto> = {}): UtteranceDto {
  return {
    id: input.id ?? "utterance-1",
    discussionId: "discussion-1",
    speakerLabel: "speaker_0",
    text: input.text ?? "一句话",
    isFinal: input.isFinal ?? true,
    source: "mock",
    createdAt: input.createdAt ?? "2026-05-28T10:00:00.000Z",
    ...input
  };
}

function aiTurn(input: Partial<AiTurnDto> = {}): AiTurnDto {
  return {
    id: input.id ?? "ai-1",
    discussionId: "discussion-1",
    prompt: "prompt",
    response: "回复",
    status: "completed",
    createdAt: input.createdAt ?? "2026-05-28T10:01:00.000Z",
    completedAt: input.completedAt ?? "2026-05-28T10:01:30.000Z",
    ...input
  };
}

function speakerBinding(input: Partial<SpeakerBindingDto> = {}): SpeakerBindingDto {
  return {
    id: "binding-1",
    discussionId: "discussion-1",
    speakerLabel: "speaker_0",
    participantId: "participant-1",
    createdAt: "2026-05-28T10:00:00.000Z",
    updatedAt: "2026-05-28T10:00:00.000Z",
    ...input
  };
}
