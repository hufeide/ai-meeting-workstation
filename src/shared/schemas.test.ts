import { describe, expect, it } from "vitest";
import { createDiscussionSchema, triggerAiTurnSchema } from "./schemas";

describe("createDiscussionSchema", () => {
  it("accepts the vNext discussion payload without title and topic", () => {
    const result = createDiscussionSchema.parse({
      background: "讨论 AI 参与项目决策的 MVP",
      projectPath: "/tmp/ai-discussion",
      participants: [{ displayName: "参与人 A" }, { displayName: "参与人 B" }]
    });

    expect(result.mode).toBe("real");
    expect(result.title).toBe("讨论会话");
    expect(result.topic).toBe("讨论 AI 参与项目决策的 MVP");
    expect(result.participants).toHaveLength(2);
  });

  it("requires at least two participants", () => {
    expect(() =>
      createDiscussionSchema.parse({
        background: "单人讨论",
        projectPath: "/tmp/project",
        participants: [{ displayName: "参与人 A" }]
      })
    ).toThrow();
  });

  it("accepts more than two participants", () => {
    const result = createDiscussionSchema.parse({
      background: "多人讨论",
      projectPath: "/tmp/project",
      participants: [{ displayName: "参与人 A" }, { displayName: "参与人 B" }, { displayName: "参与人 C" }]
    });

    expect(result.participants.map((participant) => participant.displayName)).toEqual(["参与人 A", "参与人 B", "参与人 C"]);
  });
});

describe("triggerAiTurnSchema", () => {
  it("does not accept product-level AI turn types", () => {
    const result = triggerAiTurnSchema.parse({
      contextMode: "since_last_ai_turn",
      turnType: "risk"
    });

    expect(result).toEqual({ contextMode: "since_last_ai_turn" });
  });

  it("accepts an optional one-turn guidance without making it required", () => {
    expect(triggerAiTurnSchema.parse({ contextMode: "since_last_ai_turn" })).toEqual({
      contextMode: "since_last_ai_turn"
    });
    expect(
      triggerAiTurnSchema.parse({
        contextMode: "since_last_ai_turn",
        guidance: "  只分析合同风险，不要泛泛总结。  "
      })
    ).toEqual({
      contextMode: "since_last_ai_turn",
      guidance: "只分析合同风险，不要泛泛总结。"
    });
  });
});
