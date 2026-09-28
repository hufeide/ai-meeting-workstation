import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AsrProviderType, BrainProviderType, PublicAppSettingsDto } from "../../shared/types";
import type { SettingsUpdateRequest } from "../../shared/schemas";
import type { StoragePaths } from "../storage/paths";

export type LocalSettings = {
  asrProvider: AsrProviderType;
  brainProvider: BrainProviderType;
  brainModel: string;
  claudePath: string;
  claudeModel: string;
  claudeFallbackModel: string;
  codexPath: string;
  codexModel: string;
  cliTimeoutMs: number;
  deepseekBaseUrl: string;
  deepseekModel: string;
  deepseekApiKey: string;
  openaiBaseUrl: string;
  openaiModel: string;
  openaiApiKey: string;
  volcengineApiKey: string;
  volcengineResourceId: string;
  volcengineEndpoint: string;
  recentMemoryCount: number;
  cloudAcknowledged: boolean;
};

const DEFAULT_SETTINGS: LocalSettings = {
  asrProvider: "volcengine",
  brainProvider: "deepseek",
  brainModel: "deepseek-v4-pro",
  claudePath: "claude",
  claudeModel: "opus",
  claudeFallbackModel: "sonnet",
  codexPath: "codex",
  codexModel: "",
  cliTimeoutMs: 180000,
  deepseekBaseUrl: "https://api.deepseek.com",
  deepseekModel: "deepseek-v4-pro",
  deepseekApiKey: "",
  openaiBaseUrl: "https://api.openai.com/v1",
  openaiModel: "gpt-5.6",
  openaiApiKey: "",
  volcengineApiKey: "",
  volcengineResourceId: "volc.seedasr.sauc.duration",
  volcengineEndpoint: "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async",
  recentMemoryCount: 5,
  cloudAcknowledged: false
};

export class LocalSettingsStore {
  readonly settingsPath: string;
  readonly customersDir: string;

  constructor(private readonly storagePaths: StoragePaths, private readonly env: NodeJS.ProcessEnv = process.env) {
    this.settingsPath = join(storagePaths.dataDir, "settings.local.json");
    this.customersDir = join(storagePaths.dataDir, "customers");
    mkdirSync(this.customersDir, { recursive: true });
  }

  load(): LocalSettings {
    const fileSettings = existsSync(this.settingsPath) ? readJson(this.settingsPath) : {};
    const merged = {
      ...DEFAULT_SETTINGS,
      ...fileSettings
    };

    return {
      ...merged,
      claudePath: readEnv(this.env.CLAUDE_CLI_PATH, merged.claudePath),
      codexPath: readEnv(this.env.CODEX_CLI_PATH, merged.codexPath),
      codexModel: readEnv(this.env.CODEX_MODEL, merged.codexModel),
      deepseekApiKey: readEnv(this.env.DEEPSEEK_API_KEY, merged.deepseekApiKey),
      openaiApiKey: readEnv(this.env.OPENAI_API_KEY, merged.openaiApiKey),
      volcengineApiKey: readEnv(this.env.VOLCENGINE_ASR_API_KEY, merged.volcengineApiKey),
      volcengineResourceId: readEnv(this.env.VOLCENGINE_ASR_RESOURCE_ID, merged.volcengineResourceId),
      volcengineEndpoint: readEnv(this.env.VOLCENGINE_ASR_ENDPOINT, merged.volcengineEndpoint)
    };
  }

  save(update: SettingsUpdateRequest): PublicAppSettingsDto {
    const currentFileSettings = existsSync(this.settingsPath) ? readJson(this.settingsPath) : {};
    const nextFileSettings: Record<string, unknown> = {
      ...currentFileSettings,
      ...dropUndefined({
        asrProvider: update.asrProvider,
        brainProvider: update.brainProvider,
        brainModel: update.brainModel,
        claudeModel: update.claudeModel,
        claudeFallbackModel: update.claudeFallbackModel,
        codexModel: update.codexModel,
        deepseekModel: update.deepseekModel,
        openaiModel: update.openaiModel,
        volcengineResourceId: update.volcengineResourceId,
        volcengineEndpoint: update.volcengineEndpoint,
        recentMemoryCount: update.recentMemoryCount,
        cloudAcknowledged: update.cloudAcknowledged
      })
    };

    if (update.deepseekApiKey !== undefined) nextFileSettings.deepseekApiKey = update.deepseekApiKey.trim();
    if (update.openaiApiKey !== undefined) nextFileSettings.openaiApiKey = update.openaiApiKey.trim();
    if (update.volcengineApiKey !== undefined) nextFileSettings.volcengineApiKey = update.volcengineApiKey.trim();

    mkdirSync(this.storagePaths.dataDir, { recursive: true });
    writeFileSync(this.settingsPath, `${JSON.stringify(nextFileSettings, null, 2)}\n`, "utf8");
    return this.publicSettings();
  }

  publicSettings(): PublicAppSettingsDto {
    const settings = this.load();
    return {
      asrProvider: settings.asrProvider,
      brainProvider: settings.brainProvider,
      brainModel: settings.brainModel || modelForProvider(settings),
      claudeModel: settings.claudeModel,
      claudeFallbackModel: settings.claudeFallbackModel || undefined,
      codexModel: settings.codexModel || undefined,
      deepseekModel: settings.deepseekModel,
      openaiModel: settings.openaiModel,
      volcengineResourceId: settings.volcengineResourceId,
      volcengineEndpoint: settings.volcengineEndpoint,
      recentMemoryCount: settings.recentMemoryCount,
      cloudAcknowledged: settings.cloudAcknowledged,
      keys: {
        deepseek: Boolean(settings.deepseekApiKey),
        openai: Boolean(settings.openaiApiKey),
        volcengine: Boolean(settings.volcengineApiKey)
      },
      cli: {
        claudePath: settings.claudePath,
        codexPath: settings.codexPath
      },
      storage: {
        settingsPath: this.settingsPath,
        customersDir: this.customersDir
      }
    };
  }
}

export function modelForProvider(settings: LocalSettings, provider: BrainProviderType = settings.brainProvider): string {
  if (provider === "deepseek") return settings.deepseekModel;
  if (provider === "openai") return settings.openaiModel;
  if (provider === "claude-cli") return settings.claudeModel;
  if (provider === "codex-cli") return settings.codexModel;
  return settings.brainModel || "mock";
}

function readJson(path: string): Partial<LocalSettings> {
  return JSON.parse(readFileSync(path, "utf8")) as Partial<LocalSettings>;
}

function readEnv(value: string | undefined, fallback: string): string {
  return value && value.trim() ? value.trim() : fallback;
}

function dropUndefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}
