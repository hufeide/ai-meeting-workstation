import type { UtteranceDto } from "../../shared/types";
import type { AsrEventLogEntry } from "./asrEventLog";

export type TranscriptCandidate = Omit<UtteranceDto, "id" | "discussionId" | "createdAt" | "source" | "isFinal"> & {
  text: string;
};

export type AsrProviderCredentialCheck =
  | { ok: true }
  | {
      ok: false;
      message: string;
    };

export type AsrProviderSession = {
  sendAudio(chunk: Buffer): void;
  close(): void;
};

export type AsrProviderStartInput = {
  discussionId: string;
  onPartial: (utterance: TranscriptCandidate) => void;
  onFinal: (utterance: TranscriptCandidate) => void;
  onError: (message: string) => void;
  onLog?: (entry: Omit<AsrEventLogEntry, "timestamp">) => void;
  abort?: AbortSignal;
};

export interface AsrProvider {
  checkCredentials(): AsrProviderCredentialCheck;
  startSession(input: AsrProviderStartInput): Promise<AsrProviderSession>;
}
