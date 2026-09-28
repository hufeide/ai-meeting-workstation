import type { AiTurnDto, AiTurnStatus } from "./types";

export function isUsableAiTurnStatus(status: AiTurnStatus): boolean {
  return status === "completed" || status === "truncated";
}

export function isUsableAiTurn(turn: AiTurnDto): boolean {
  return isUsableAiTurnStatus(turn.status) && Boolean(turn.response?.trim());
}
