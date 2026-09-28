import { describe, expect, it } from "vitest";
import { codexResumeCommand } from "./codexCommand";

describe("codex resume command", () => {
  it("uses the interactive resume command in the discussion project directory", () => {
    expect(
      codexResumeCommand({
        codexThreadId: "thread-123",
        projectPath: "/tmp/ai-discussion"
      })
    ).toBe("codex resume -C /tmp/ai-discussion thread-123");
  });

  it("quotes project paths with spaces", () => {
    expect(
      codexResumeCommand({
        codexThreadId: "thread-123",
        projectPath: "/tmp/my project/ai discussion"
      })
    ).toBe("codex resume -C '/tmp/my project/ai discussion' thread-123");
  });
});
