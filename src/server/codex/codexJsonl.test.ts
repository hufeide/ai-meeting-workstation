import { describe, expect, it } from "vitest";
import { parseCodexJsonl } from "./codexJsonl";

describe("parseCodexJsonl", () => {
  it("extracts thread id and final agent text from Codex JSONL with warning noise", () => {
    const parsed = parseCodexJsonl(
      [
        "2026-05-27T07:56:16Z WARN plugin sync failed",
        "{\"type\":\"thread.started\",\"thread_id\":\"019e686f-2d16-7102-b7ab-744df9e6bdf4\"}",
        "{\"type\":\"turn.started\"}",
        "{\"type\":\"item.completed\",\"item\":{\"id\":\"item_0\",\"type\":\"agent_message\",\"text\":\"OK\"}}",
        "{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":10}}"
      ].join("\n")
    );

    expect(parsed.threadId).toBe("019e686f-2d16-7102-b7ab-744df9e6bdf4");
    expect(parsed.finalText).toBe("OK");
    expect(parsed.events).toHaveLength(4);
  });

  it("extracts assistant text from message content arrays", () => {
    const parsed = parseCodexJsonl(
      "{\"type\":\"item.completed\",\"item\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"第一段\"},{\"type\":\"output_text\",\"text\":\"第二段\"}]}}"
    );

    expect(parsed.finalText).toBe("第一段第二段");
  });
});
