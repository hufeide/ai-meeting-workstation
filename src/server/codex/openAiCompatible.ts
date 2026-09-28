import {
  buildDiscussionTurnPrompt,
  TruncatedAiResponseError,
  type CodexProvider,
  type CodexTurnInput,
  type CreateCodexThreadInput
} from "./provider";

export const OPENAI_COMPATIBLE_MAX_OUTPUT_TOKENS = 4096;

type OpenAiCompatibleConfig = {
  label: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
};

type ChatCompletionResponse = {
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      content?: string;
    };
  }>;
  error?: {
    message?: string;
  };
};

export class OpenAiCompatibleProvider implements CodexProvider {
  constructor(private readonly config: OpenAiCompatibleConfig) {}

  async createThread(input: CreateCodexThreadInput): Promise<string> {
    return `${this.config.label.toLowerCase()}-${slugify(input.discussion.title)}-${Date.now()}`;
  }

  buildPrompt(input: CodexTurnInput): string {
    return buildDiscussionTurnPrompt(input.discussion, input.utterances, input.memoryContext, input.guidance);
  }

  async respond(input: CodexTurnInput): Promise<string> {
    return this.completePrompt({ prompt: this.buildPrompt(input) });
  }

  async completePrompt(input: { prompt: string }): Promise<string> {
    if (!this.config.apiKey) {
      throw new Error(`${this.config.label} API Key 未配置，请在设置里填写客户自己的 key。`);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 90000);

    try {
      const response = await fetch(`${this.config.baseUrl.replace(/\/$/, "")}/v1/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`
        },
        body: JSON.stringify({
          model: this.config.model,
          temperature: 0.4,
          max_tokens: OPENAI_COMPATIBLE_MAX_OUTPUT_TOKENS,
          messages: [
            {
              role: "system",
              content: "你是会议中的 AI 参谋，只给有增量、可执行、不过度奉承的中文建议。"
            },
            {
              role: "user",
              content: input.prompt
            }
          ]
        })
      });

      const payload = (await response.json().catch(() => ({}))) as ChatCompletionResponse;
      if (!response.ok) {
        throw new Error(payload.error?.message || `${this.config.label} API 请求失败：HTTP ${response.status}`);
      }

      const choice = payload.choices?.[0];
      const finishReason = choice?.finish_reason;
      const content = choice?.message?.content?.trim();
      if (finishReason === "length") {
        if (!content) {
          throw new Error(`${this.config.label} API 返回被截断但没有可用内容。`);
        }
        throw new TruncatedAiResponseError(content);
      }
      if (finishReason && finishReason !== "stop") {
        throw new Error(`${this.config.label} API 回复未正常结束：${finishReason}`);
      }

      if (!content) {
        throw new Error(`${this.config.label} API 返回为空。`);
      }
      return content;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}
