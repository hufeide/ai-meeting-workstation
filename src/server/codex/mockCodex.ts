import { buildDiscussionTurnPrompt, type CodexProvider, type CodexTurnInput, type CreateCodexThreadInput } from "./provider";

export class MockCodexProvider implements CodexProvider {
  async createThread(input: CreateCodexThreadInput): Promise<string> {
    return `mock-thread-${slugify(input.discussion.title)}-${Date.now()}`;
  }

  buildPrompt(input: CodexTurnInput): string {
    return buildDiscussionTurnPrompt(input.discussion, input.utterances, input.memoryContext, input.guidance);
  }

  async respond(input: CodexTurnInput): Promise<string> {
    if (input.utterances.length === 0) {
      return "我现在还没有看到新的转写内容，可以先继续讨论一小段，等有具体观点后再邀请我介入。";
    }

    return "我听到的关键点是：你们正在把 AI 介入方式收敛到更自然的讨论流里。我的判断是先别急着加复杂能力，应该用一次真实讨论验证两个问题：你们是否愿意在合适节点手动邀请 AI，以及 AI 的回复是否真的改变了后续讨论方向。";
  }

  async completePrompt(input: { prompt: string }): Promise<string> {
    return `【记忆草稿】\n${input.prompt.slice(0, 420)}\n\n- 决策：继续用真实会议验证 AI 参与价值。\n- 待办：保留人工确认后再入库。`;
  }
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}
