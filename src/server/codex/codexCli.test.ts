import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DiscussionDetailDto } from "../../shared/types";
import { CodexCliProvider } from "./codexCli";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "codex-cli-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("CodexCliProvider", () => {
  it("creates a thread from Codex JSONL output", async () => {
    const argsPath = join(tempDir, "create-args.json");
    const cliPath = createFakeCodexCli('{"type":"thread.started","thread_id":"thread-123"}\n{"type":"item.completed","item":{"type":"agent_message","text":"ready"}}', argsPath);
    const provider = new CodexCliProvider({ cliPath, timeoutMs: 5000 });

    await expect(
      provider.createThread({
        discussion: {
          title: "MVP",
          topic: "Codex CLI",
          background: "验证 Codex CLI 初始化。",
          projectPath: tempDir,
          participants: [{ displayName: "参与人 A" }, { displayName: "参与人 B" }],
          mode: "mock"
        }
      })
    ).resolves.toBe("thread-123");
    expect(readCliArgs(argsPath)).toEqual(["exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only", "-"]);
  });

  it("returns the thread id without waiting for the initial Codex response to finish", async () => {
    const argsPath = join(tempDir, "create-args.json");
    const completedPath = join(tempDir, "create-completed");
    const cliPath = createFakeCodexCli(
      '{"type":"thread.started","thread_id":"thread-123"}\n',
      argsPath,
      [
        "setTimeout(() => {",
        `require("node:fs").writeFileSync(${JSON.stringify(completedPath)}, "done");`,
        'process.stdout.write("{\\"type\\":\\"item.completed\\",\\"item\\":{\\"type\\":\\"agent_message\\",\\"text\\":\\"ready\\"}}\\n");',
        "}, 500);"
      ].join("\n")
    );
    const provider = new CodexCliProvider({ cliPath, timeoutMs: 5000 });

    await expect(
      provider.createThread({
        discussion: {
          title: "MVP",
          topic: "Codex CLI",
          background: "验证 Codex CLI 初始化。",
          projectPath: tempDir,
          participants: [{ displayName: "参与人 A" }, { displayName: "参与人 B" }],
          mode: "mock"
        }
      })
    ).resolves.toBe("thread-123");

    expect(existsSync(completedPath)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 600));
  });

  it("resumes the stored thread and returns the final assistant text", async () => {
    const argsPath = join(tempDir, "resume-args.json");
    const cliPath = createFakeCodexCli('{"type":"thread.started","thread_id":"thread-123"}\n{"type":"item.completed","item":{"type":"agent_message","text":"继续推进 MVP。"}}', argsPath);
    const provider = new CodexCliProvider({ cliPath, timeoutMs: 5000 });

    await expect(provider.respond({ discussion: createDiscussion(), utterances: [] })).resolves.toBe("继续推进 MVP。");
    expect(readCliArgs(argsPath)).toEqual(["exec", "resume", "--json", "--skip-git-repo-check", "thread-123", "-"]);
  });
});

function createFakeCodexCli(jsonl: string, argsPath: string, afterWriteScript = ""): string {
  const cliPath = join(tempDir, "codex");
  writeFileSync(
    cliPath,
    [
      "#!/usr/bin/env node",
      `require("node:fs").writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));`,
      `process.stdout.write(${JSON.stringify(jsonl)});`,
      afterWriteScript
    ].join("\n")
  );
  chmodSync(cliPath, 0o755);
  return cliPath;
}

function readCliArgs(argsPath: string): string[] {
  return JSON.parse(readFileSync(argsPath, "utf8")) as string[];
}

function createDiscussion(): DiscussionDetailDto {
  return {
    id: "discussion-1",
    title: "项目增长策略讨论",
    topic: "验证 Codex CLI 续接",
    projectPath: tempDir,
    mode: "mock",
    codexThreadId: "thread-123",
    status: "active",
    createdAt: "2026-05-27T00:00:00.000Z",
    startedAt: "2026-05-27T00:00:00.000Z",
    participants: [
      { id: "p1", discussionId: "discussion-1", displayName: "参与人 A", sortOrder: 0 },
      { id: "p2", discussionId: "discussion-1", displayName: "参与人 B", sortOrder: 1 }
    ],
    speakerBindings: [],
    utterances: [],
    aiTurns: [],
    audioAssets: []
  };
}
