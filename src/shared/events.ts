import type { AiTurnDto, AudioAssetDto, DiscussionDto, SpeakerBindingDto, UtteranceDto } from "./types";

export type AsrStatus = "idle" | "connecting" | "connected" | "receiving" | "failed" | "closed";
export type CodexStatus = "idle" | "starting" | "ready" | "responding" | "failed";
export type AsrErrorCode = "auth_failed" | "connection_failed" | "quota_exceeded" | "audio_format_invalid" | "vendor_error";

export type ProductEvent =
  | { type: "discussion.updated"; discussion: DiscussionDto }
  | { type: "transcript.partial"; utterance: UtteranceDto }
  | { type: "transcript.final"; utterance: UtteranceDto }
  | { type: "speaker.binding.updated"; binding: SpeakerBindingDto }
  | { type: "codex.turn.started"; aiTurnId: string }
  | { type: "codex.turn.completed"; aiTurn: AiTurnDto }
  | { type: "codex.turn.truncated"; aiTurn: AiTurnDto }
  | { type: "codex.turn.failed"; aiTurnId: string; message: string }
  | { type: "asr.status"; status: AsrStatus }
  | { type: "asr.error"; code: AsrErrorCode; message: string; retryable: boolean }
  | { type: "asr.log"; message: string }
  | { type: "audio.asset.saved"; asset: AudioAssetDto }
  | { type: "codex.status"; status: CodexStatus };
