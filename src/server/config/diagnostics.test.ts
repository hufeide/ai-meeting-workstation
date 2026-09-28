import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDiagnostics } from "./diagnostics";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "ai-discussion-doctor-"));
  writeFileSync(join(tempDir, "package.json"), "{}");
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("runDiagnostics", () => {
  it("reports missing real ASR credentials as warnings", async () => {
    const report = await runDiagnostics(
      {
        APP_DATA_DIR: tempDir,
        CODEX_PROVIDER: "mock",
        CODEX_CLI_PATH: "node"
      },
      tempDir
    );

    expect(report.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "VOLCENGINE_ASR_API_KEY 已配置", status: "warn" }),
        expect.objectContaining({ label: "VOLCENGINE_ASR_RESOURCE_ID 已配置", status: "warn" })
      ])
    );
  });

  it("marks invalid ports as required failures", async () => {
    const report = await runDiagnostics(
      {
        APP_PORT: "invalid",
        APP_DATA_DIR: tempDir,
        CODEX_CLI_PATH: "node"
      },
      tempDir
    );

    expect(report.ok).toBe(false);
    expect(report.items).toEqual(expect.arrayContaining([expect.objectContaining({ label: "APP_PORT 有效", status: "fail" })]));
  });

  it("reports a Python environment without FunASR as an optional warning", async () => {
    const report = await runDiagnostics(
      {
        APP_DATA_DIR: tempDir,
        CODEX_PROVIDER: "mock",
        CODEX_CLI_PATH: "node",
        FUNASR_PYTHON_PATH: process.execPath,
        FUNASR_HOME: tempDir
      },
      tempDir
    );

    expect(report.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "FunASR Python 可执行", status: "pass" }),
        expect.objectContaining({ label: "FunASR Python 包可导入", status: "warn" })
      ])
    );
  });
});
