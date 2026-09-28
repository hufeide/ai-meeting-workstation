import { describe, expect, it } from "vitest";
import { normalizeVolcengineFileSpeaker } from "../../../server/asr/volcengineFile";
import { speakerLetter } from "./App";

describe("speaker label display", () => {
  it("displays Volcengine file speaker groups 1-4 as A-D after provider-specific normalization", () => {
    const labels = [1, 2, 3, 4].map((speaker) =>
      normalizeVolcengineFileSpeaker({ additions: { speaker } })
    );

    expect(labels).toEqual(["speaker_0", "speaker_1", "speaker_2", "speaker_3"]);
    expect(labels.map(speakerLetter)).toEqual(["A", "B", "C", "D"]);
  });

  it("keeps the existing zero-based labels used by FunASR, streaming ASR and Mock", () => {
    expect(speakerLetter("speaker_0")).toBe("A");
    expect(speakerLetter("speaker_1")).toBe("B");
  });
});
