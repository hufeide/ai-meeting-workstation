import type { BrainProviderType } from "../../shared/types";
import { modelForProvider, type LocalSettingsStore } from "../settings/localSettings";
import { ClaudeCliProvider } from "./claudeCli";
import { CodexCliProvider } from "./codexCli";
import { MockCodexProvider } from "./mockCodex";
import { OpenAiCompatibleProvider } from "./openAiCompatible";
import type { CodexProvider } from "./provider";

export class BrainProviderRegistry {
  constructor(private readonly settingsStore: LocalSettingsStore) {}

  getProvider(providerType?: BrainProviderType, modelOverride?: string): CodexProvider {
    const settings = this.settingsStore.load();
    const provider = providerType ?? settings.brainProvider;
    const model = modelOverride || modelForProvider(settings, provider);

    if (provider === "mock") return new MockCodexProvider();
    if (provider === "claude-cli") {
      // CLI backends are only for users running their own local subscription.
      // Never package or distribute a developer's Claude/Codex token with this product.
      return new ClaudeCliProvider({
        cliPath: settings.claudePath,
        model: model || settings.claudeModel,
        fallbackModel: settings.claudeFallbackModel,
        timeoutMs: settings.cliTimeoutMs
      });
    }
    if (provider === "codex-cli") {
      return new CodexCliProvider({
        cliPath: settings.codexPath,
        model: model || undefined,
        timeoutMs: settings.cliTimeoutMs
      });
    }
    if (provider === "deepseek") {
      return new OpenAiCompatibleProvider({
        label: "DeepSeek",
        baseUrl: settings.deepseekBaseUrl,
        apiKey: settings.deepseekApiKey,
        model: model || settings.deepseekModel,
        timeoutMs: 90000
      });
    }
    if (provider === "openai") {
      return new OpenAiCompatibleProvider({
        label: "OpenAI",
        baseUrl: settings.openaiBaseUrl,
        apiKey: settings.openaiApiKey,
        model: model || settings.openaiModel,
        timeoutMs: 90000
      });
    }
    if (provider === "local-qwen") {
      throw new Error("本地 Qwen 大脑接口已预留，但本轮未实现。");
    }
    throw new Error(`未知大脑 provider：${String(provider)}`);
  }
}
