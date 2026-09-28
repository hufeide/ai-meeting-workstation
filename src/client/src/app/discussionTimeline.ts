import type { AiTurnDto, DiscussionDetailDto, UtteranceDto } from "../../../shared/types";
import { isUsableAiTurn } from "../../../shared/aiTurns";

export type TimelineItem =
  | {
      type: "utterance";
      id: string;
      sortTime: string;
      utterance: UtteranceDto;
    }
  | {
      type: "aiTurn";
      id: string;
      sortTime: string;
      aiTurn: AiTurnDto;
    }
  | {
      type: "codexPending";
      id: string;
      sortTime: string;
    };

export function mergeUtterance(current: DiscussionDetailDto | null, utterance: UtteranceDto): DiscussionDetailDto | null {
  if (!current) return current;
  const activeUtterances = utterance.isFinal
    ? current.utterances.filter((item) => item.isFinal || item.speakerLabel !== utterance.speakerLabel)
    : current.utterances;
  const utterances = activeUtterances.some((item) => item.id === utterance.id)
    ? activeUtterances.map((item) => (item.id === utterance.id ? utterance : item))
    : [...activeUtterances, utterance];
  return { ...current, utterances };
}

export function mergeAiTurn(current: DiscussionDetailDto | null, aiTurn: AiTurnDto): DiscussionDetailDto | null {
  if (!current) return current;
  const aiTurns = current.aiTurns.some((item) => item.id === aiTurn.id)
    ? current.aiTurns.map((item) => (item.id === aiTurn.id ? aiTurn : item))
    : [...current.aiTurns, aiTurn];
  return { ...current, aiTurns };
}

export function buildDiscussionTimeline(discussion: DiscussionDetailDto): TimelineItem[] {
  return [
    ...discussion.utterances.map<TimelineItem>((utterance) => ({
      type: "utterance",
      id: utterance.id,
      sortTime: utteranceSortTime(discussion, utterance),
      utterance
    })),
    ...discussion.aiTurns
      .filter(isUsableAiTurn)
      .map<TimelineItem>((aiTurn) => ({
        type: "aiTurn",
        id: aiTurn.id,
        sortTime: aiTurnSortTime(discussion, aiTurn),
        aiTurn
      }))
  ].sort((left, right) => {
    const delta = Date.parse(left.sortTime) - Date.parse(right.sortTime);
    return delta === 0 ? left.id.localeCompare(right.id) : delta;
  });
}

function aiTurnSortTime(discussion: DiscussionDetailDto, aiTurn: AiTurnDto): string {
  if (aiTurn.triggerEndUtteranceId) {
    const triggerUtterance = discussion.utterances.find(
      (utterance) => utterance.id === aiTurn.triggerEndUtteranceId
    );
    if (triggerUtterance && (triggerUtterance.source === "funasr" || triggerUtterance.source === "upload")) {
      const triggerTimeMs = Date.parse(utteranceSortTime(discussion, triggerUtterance));
      if (!Number.isNaN(triggerTimeMs)) return new Date(triggerTimeMs + 1).toISOString();
    }
  }
  return aiTurn.completedAt ?? aiTurn.createdAt;
}

function utteranceSortTime(discussion: DiscussionDetailDto, utterance: UtteranceDto): string {
  if (discussion.startedAt && utterance.startMs !== undefined) {
    const startedAtMs = Date.parse(discussion.startedAt);
    if (!Number.isNaN(startedAtMs)) return new Date(startedAtMs + utterance.startMs).toISOString();
  }
  return utterance.createdAt;
}

export function buildVisibleDiscussionTimeline(
  discussion: DiscussionDetailDto,
  options: { isInvitingCodex: boolean }
): TimelineItem[] {
  const timeline = discussion.status === "ended"
    ? buildDiscussionTimeline(discussion).filter((item) => item.type === "aiTurn" || (item.type === "utterance" && item.utterance.isFinal))
    : buildDiscussionTimeline(discussion);

  if (!options.isInvitingCodex || discussion.status === "ended") return timeline;

  return [
    ...timeline,
    {
      type: "codexPending",
      id: "codex-pending",
      sortTime: new Date().toISOString()
    }
  ];
}

export function unboundSpeakerLabels(discussion: DiscussionDetailDto): string[] {
  const boundLabels = new Set(discussion.speakerBindings.map((binding) => binding.speakerLabel));
  const labels = discussion.utterances
    .map((utterance) => utterance.speakerLabel)
    .filter((label) => !boundLabels.has(label));
  return Array.from(new Set(labels)).sort();
}
