import { describe, expect, it } from "vitest";
import { formatFileSize, parseKnownSpeakers, taskModeForDiscussion, transcriptionNameFromFile } from "./taskMode";

describe("task mode routing", () => {
  it("restores file transcription records directly into file result mode", () => {
    expect(taskModeForDiscussion({ asrProvider: "volcengine-file" })).toBe("file");
    expect(taskModeForDiscussion({ asrProvider: "funasr" })).toBe("file");
    expect(taskModeForDiscussion({ asrProvider: "volcengine" })).toBe("live");
    expect(taskModeForDiscussion({ asrProvider: "mock" })).toBe("live");
  });

  it("derives a readable default transcription name and file size", () => {
    expect(transcriptionNameFromFile("客户访谈.m4a")).toBe("客户访谈");
    expect(formatFileSize(2 * 1024 * 1024)).toBe("2.0 MB");
  });

  it("accepts optional known speaker names without guessing identities", () => {
    expect(parseKnownSpeakers("项目经理，客户经理").map((item) => item.displayName)).toEqual(["项目经理", "客户经理"]);
    expect(parseKnownSpeakers("").map((item) => item.displayName)).toEqual(["参与人 A", "参与人 B"]);
  });
});
