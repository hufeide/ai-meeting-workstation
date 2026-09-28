import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadServerConfig, resolveFunasrRuntime } from "./serverConfig";

describe("loadServerConfig", () => {
  it("prefers an installed app-local model cache over the legacy parent cache", () => {
    const root = mkdtempSync(join(tmpdir(), "meeting-asr-path-"));
    const app = join(root, "app", "workstation");
    try {
      mkdirSync(join(app, ".modelscope_cache"), { recursive: true });
      mkdirSync(join(root, ".modelscope_cache"));
      expect(resolveFunasrRuntime({}, app).asrHome).toBe(app);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses real ASR mode and Codex CLI by default", () => {
    const config = loadServerConfig({
      VOLCENGINE_ASR_API_KEY: "api-key",
      VOLCENGINE_ASR_RESOURCE_ID: "volc.seedasr.sauc.duration"
    });

    expect(config.defaultMode).toBe("real");
    expect(config.codexProvider).toBe("cli");
    expect(config.funasrFileTimeoutMs).toBe(21_600_000);
    expect(config.funasrDevice).toBe("auto");
    expect(config.funasrHotwordFile).toMatch(/config\/hotwords\/active\.txt$/);
    expect(config.volcengineAsr.apiKey).toBe("api-key");
    expect(config.volcengineAsr.resourceId).toBe("volc.seedasr.sauc.duration");
  });

  it("does not fall back to mock ASR when credentials are missing", () => {
    const config = loadServerConfig({});

    expect(config.defaultMode).toBe("real");
  });

  it("allows explicitly selecting the mock Codex provider for tests or local experiments", () => {
    const config = loadServerConfig({
      CODEX_PROVIDER: "mock"
    });

    expect(config.codexProvider).toBe("mock");
  });

  it("rejects invalid ports with a readable error", () => {
    expect(() => loadServerConfig({ APP_PORT: "abc" })).toThrow("APP_PORT");
  });

  it("allows configuring a longer FunASR file-processing timeout", () => {
    const config = loadServerConfig({
      CODEX_PROVIDER: "mock",
      FUNASR_FILE_TIMEOUT_MS: "43200000"
    });

    expect(config.funasrFileTimeoutMs).toBe(43_200_000);
  });

  it("rejects invalid FunASR file-processing timeouts", () => {
    expect(() =>
      loadServerConfig({ CODEX_PROVIDER: "mock", FUNASR_FILE_TIMEOUT_MS: "0" })
    ).toThrow("FUNASR_FILE_TIMEOUT_MS");
  });

  it("allows selecting the FunASR inference device", () => {
    const config = loadServerConfig({ CODEX_PROVIDER: "mock", FUNASR_DEVICE: "mps" });

    expect(config.funasrDevice).toBe("mps");
  });

  it("allows replacing the FunASR hotword list without changing code", () => {
    const config = loadServerConfig({
      CODEX_PROVIDER: "mock",
      FUNASR_HOTWORD_FILE: "config/hotwords/furniture.txt"
    });

    expect(config.funasrHotwordFile).toMatch(/config\/hotwords\/furniture\.txt$/);
  });

  it("allows configuring portable FunASR paths without changing code", () => {
    const config = loadServerConfig({
      CODEX_PROVIDER: "mock",
      FUNASR_PYTHON_PATH: "python3",
      FUNASR_HOME: "/tmp/meeting-workstation-asr"
    });

    expect(config.funasrPythonPath).toBe("python3");
    expect(config.funasrAsrHome).toBe("/tmp/meeting-workstation-asr");
  });

  it("rejects an unsupported FunASR inference device", () => {
    expect(() => loadServerConfig({ CODEX_PROVIDER: "mock", FUNASR_DEVICE: "cuda" })).toThrow(
      "FUNASR_DEVICE"
    );
  });

  it("requires CODEX_CLI_PATH when the CLI provider is enabled", () => {
    expect(() => loadServerConfig({ CODEX_PROVIDER: "cli", CODEX_CLI_PATH: "" })).toThrow("CODEX_CLI_PATH");
  });
});
