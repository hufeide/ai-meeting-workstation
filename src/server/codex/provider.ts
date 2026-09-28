import type { CreateDiscussionRequest } from "../../shared/schemas";
import { AI_RESPONSE_TRUNCATED_MESSAGE } from "../../shared/messages";
import type { DiscussionDetailDto, UtteranceDto } from "../../shared/types";
export { buildDiscussionTurnPrompt, buildInitialDiscussionPrompt } from "../discussions/promptPolicy";

export type CreateCodexThreadInput = {
  discussion: CreateDiscussionRequest;
};

export type CodexTurnInput = {
  discussion: DiscussionDetailDto;
  utterances: UtteranceDto[];
  memoryContext?: string;
  guidance?: string;
};

export class TruncatedAiResponseError extends Error {
  readonly partialResponse: string;

  constructor(partialResponse: string) {
    super(AI_RESPONSE_TRUNCATED_MESSAGE);
    this.name = "TruncatedAiResponseError";
    this.partialResponse = partialResponse;
  }
}

export interface CodexProvider {
  createThread(input: CreateCodexThreadInput): Promise<string>;
  buildPrompt(input: CodexTurnInput): string;
  respond(input: CodexTurnInput): Promise<string>;
  completePrompt(input: { prompt: string; cwd?: string }): Promise<string>;
}
