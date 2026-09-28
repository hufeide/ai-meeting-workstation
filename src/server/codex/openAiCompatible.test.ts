import { afterEach, describe, expect, it, vi } from "vitest";
import { AI_RESPONSE_TRUNCATED_MESSAGE } from "../../shared/messages";
import { OPENAI_COMPATIBLE_MAX_OUTPUT_TOKENS, OpenAiCompatibleProvider } from "./openAiCompatible";
import { TruncatedAiResponseError } from "./provider";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenAiCompatibleProvider", () => {
  it("allows a practical meeting response budget above the former 900-token ceiling", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content: "这是一条完整的会议建议。" } }]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = createProvider();

    await expect(provider.completePrompt({ prompt: "给出下一步建议" })).resolves.toBe("这是一条完整的会议建议。");

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as { max_tokens: number };
    expect(OPENAI_COMPATIBLE_MAX_OUTPUT_TOKENS).toBe(4096);
    expect(body.max_tokens).toBe(4096);
  });

  it("preserves a partial response when finish_reason is length", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ finish_reason: "length", message: { content: "这只是说到一半的" } }]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
    );
    const provider = createProvider();

    await expect(provider.completePrompt({ prompt: "构造截断响应" })).rejects.toMatchObject({
      name: TruncatedAiResponseError.name,
      message: AI_RESPONSE_TRUNCATED_MESSAGE,
      partialResponse: "这只是说到一半的"
    });
  });

  it("treats a length response without usable content as a real failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ finish_reason: "length", message: { content: "   " } }]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
    );
    const provider = createProvider();

    await expect(provider.completePrompt({ prompt: "构造空截断响应" })).rejects.toThrow("返回被截断但没有可用内容");
  });
});

function createProvider(): OpenAiCompatibleProvider {
  return new OpenAiCompatibleProvider({
    label: "DeepSeek",
    baseUrl: "https://example.invalid",
    apiKey: "test-key",
    model: "deepseek-v4-pro"
  });
}
