import { describe, expect, it } from "vitest";
import { AI_RESPONSE_TRUNCATED_MESSAGE, AI_RESPONSE_TRUNCATED_NOTICE } from "../../../shared/messages";
import { aiTurnSystemNotice, mainErrorText } from "./errorPresentation";

describe("mainErrorText", () => {
  it("shows the full truncation warning in the main interface", () => {
    expect(mainErrorText(AI_RESPONSE_TRUNCATED_MESSAGE)).toBe("回复因长度限制被截断");
  });
});

describe("aiTurnSystemNotice", () => {
  it("labels a truncated response as a system notice instead of model text", () => {
    expect(aiTurnSystemNotice("truncated")).toBe(AI_RESPONSE_TRUNCATED_NOTICE);
    expect(aiTurnSystemNotice("completed")).toBeUndefined();
    expect(AI_RESPONSE_TRUNCATED_NOTICE).toContain("系统提示：");
  });
});
