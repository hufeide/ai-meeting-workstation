import { describe, expect, it, vi } from "vitest";
import type { DiscussionDetailDto } from "../../../shared/types";
import { runFileTranscription, selectFileForTranscription, type FileTranscriptionState } from "./fileTranscriptionFlow";
import { SingleFlight } from "./singleFlight";

const discussion = { id: "file-1", asrProvider: "volcengine-file", utterances: [] } as unknown as DiscussionDetailDto;
const completed = { ...discussion, utterances: [{ id: "u1" }] } as unknown as DiscussionDetailDto;
const empty: FileTranscriptionState = { file: null, discussion: null, status: "waiting", errorMessage: null };

describe("file transcription flow", () => {
  it("selects a file without creating a discussion or uploading", () => {
    const file = new File(["fixture"], "meeting.mp3", { type: "audio/mpeg" });
    const next = selectFileForTranscription(empty, file);
    expect(next.file).toBe(file);
    expect(next.status).toBe("waiting");
    expect(next.discussion).toBeNull();
  });

  it("creates the internal discussion and uploads only after start", async () => {
    const file = new File(["fixture"], "meeting.mp3", { type: "audio/mpeg" });
    const createDiscussion = vi.fn(async () => discussion);
    const upload = vi.fn(async () => completed);
    const next = await runFileTranscription({ state: selectFileForTranscription(empty, file), flight: new SingleFlight(), createDiscussion, upload });
    expect(createDiscussion).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(next.status).toBe("completed");
  });

  it("blocks a concurrent start and unlocks after success", async () => {
    const file = new File(["fixture"], "meeting.mp3");
    let release: (() => void) | undefined;
    const delayed = new Promise<DiscussionDetailDto>((resolve) => { release = () => resolve(completed); });
    const flight = new SingleFlight();
    const upload = vi.fn(() => delayed);
    const state = selectFileForTranscription(empty, file);
    const first = runFileTranscription({ state, flight, createDiscussion: async () => discussion, upload });
    const second = await runFileTranscription({ state, flight, createDiscussion: async () => discussion, upload });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(second).toBe(state);
    release?.();
    expect((await first).status).toBe("completed");
    expect(flight.isActive).toBe(false);
  });

  it("unlocks after failure and keeps the file and discussion for retry", async () => {
    const file = new File(["fixture"], "meeting.mp3");
    const flight = new SingleFlight();
    const failed = await runFileTranscription({
      state: { ...empty, file, discussion },
      flight,
      createDiscussion: async () => discussion,
      upload: async () => { throw new Error("隔离失败"); }
    });
    expect(failed.status).toBe("failed");
    expect(failed.file).toBe(file);
    expect(failed.discussion).toBe(discussion);
    expect(flight.isActive).toBe(false);
    const retried = await runFileTranscription({ state: failed, flight, createDiscussion: async () => discussion, upload: async () => completed });
    expect(retried.status).toBe("completed");
  });
});
