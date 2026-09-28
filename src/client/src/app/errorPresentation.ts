import { AI_RESPONSE_TRUNCATED_MESSAGE, AI_RESPONSE_TRUNCATED_NOTICE } from "../../../shared/messages";
import type { AiTurnDto, AiTurnStatus } from "../../../shared/types";

export function mainErrorText(message: string): string {
  if (message.includes(AI_RESPONSE_TRUNCATED_MESSAGE)) return AI_RESPONSE_TRUNCATED_MESSAGE;
  if (message.includes("麦克风") || message.includes("permission") || message.includes("Permission")) return "需要麦克风权限";
  if (message.includes("ASR") || message.includes("转写")) return "转写暂不可用";
  if (message.includes("Codex")) return "Codex 暂不可接续";
  return "需要打开设置";
}

export function aiTurnSystemNotice(status: AiTurnStatus): string | undefined {
  return status === "truncated" ? AI_RESPONSE_TRUNCATED_NOTICE : undefined;
}

export function aiTurnDisplayText(turn: AiTurnDto): string {
  return [turn.response?.trim(), aiTurnSystemNotice(turn.status)].filter(Boolean).join("\n\n");
}
