import type { DiscussionDetailDto } from "../../../shared/types";
import { SingleFlight } from "./singleFlight";

export type FileTranscriptionState = {
  file: File | null;
  discussion: DiscussionDetailDto | null;
  status: "waiting" | "uploading" | "completed" | "failed";
  errorMessage: string | null;
};

export function selectFileForTranscription(state: FileTranscriptionState, file: File): FileTranscriptionState {
  return { ...state, file, status: "waiting", errorMessage: null };
}

export async function runFileTranscription(input: {
  state: FileTranscriptionState;
  flight: SingleFlight;
  createDiscussion: () => Promise<DiscussionDetailDto>;
  upload: (discussion: DiscussionDetailDto, file: File) => Promise<DiscussionDetailDto>;
}): Promise<FileTranscriptionState> {
  if (!input.state.file) return input.state;
  let nextState = input.state;
  const accepted = await input.flight.run(async () => {
    try {
      const discussion = input.state.discussion ?? await input.createDiscussion();
      const completed = await input.upload(discussion, input.state.file as File);
      nextState = { file: input.state.file, discussion: completed, status: "completed", errorMessage: null };
    } catch (error) {
      nextState = {
        ...input.state,
        status: "failed",
        errorMessage: error instanceof Error ? error.message : "录音文件识别失败。"
      };
    }
  });
  return accepted ? nextState : input.state;
}
