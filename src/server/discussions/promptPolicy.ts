import type { CreateDiscussionRequest } from "../../shared/schemas";
import type { DiscussionDetailDto, UtteranceDto } from "../../shared/types";

export function buildInitialDiscussionPrompt(input: CreateDiscussionRequest): string {
  const participants = input.participants
    .map((participant, index) => `${index + 1}. ${participant.displayName}`)
    .join("\n");

  return [
    "你将作为“第三位”讨论者参与一个讨论（实际可能不止两个人类讨论者，第三位只是表示你的参与身份）。",
    `讨论背景：${input.background}`,
    `参与人：\n${participants}`,
    "你的定位：你是一个中立的讨论者，不要无脑附和观点，要有自己的思考和判断力，你可以自由发表自己的观点，可以尖锐得指出讨论者们的问题，不需要给大家留情面。同时你也要提出自己的方案和办法，但是你的方案要是可落地的，也要符合讨论者们的主题和目的。",
    "同时，讨论的主题可能会和一开始的讨论背景有偏离，你可以及时指出偏题，同时询问是否要切换出题了。",
    "还有就是你每次回复的时候，可以先总结一下每个讨论者的观点，然后再发表你自己的看法",
    "请只回复一句简短确认，表示你已经理解本次讨论背景并等待后续讨论内容。"
  ].join("\n\n");
}

export function buildDiscussionTurnPrompt(
  discussion: DiscussionDetailDto,
  utterances: UtteranceDto[],
  memoryContext = "",
  guidance = ""
): string {
  const transcript = utterances
    .map((utterance) => {
      const participant = discussion.participants.find((item) => item.id === utterance.participantId);
      return `${participant?.displayName ?? utterance.speakerLabel}: ${utterance.text}`;
    })
    .join("\n");

  return [
    memoryContext.trim(),
    "你是会议中的 AI 参谋。请只基于“上次 AI 发言之后新增的对话”给出有增量的观点：指出盲点、风险、可落地建议或下一步，不要泛泛总结。",
    guidance.trim() ? `【主持人本轮引导】\n${guidance.trim()}\n请优先直接回应这项引导，不要转向无关的通用建议。` : "",
    "",
    "【本次新增对话】",
    transcript || "当前还没有新的转写内容。",
    "",
    "输出要求：中文，短段落，直接给观点；没有足够内容时明确说还需要更多信息。"
  ]
    .filter(Boolean)
    .join("\n");
}
