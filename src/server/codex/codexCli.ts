import { spawn } from "node:child_process";
import { buildDiscussionTurnPrompt, buildInitialDiscussionPrompt, type CodexProvider, type CodexTurnInput, type CreateCodexThreadInput } from "./provider";
import { extractThreadId, parseCodexJsonl } from "./codexJsonl";

type CodexCliConfig = {
  cliPath: string;
  timeoutMs: number;
  model?: string;
};

type CodexRunResult = {
  threadId?: string;
  finalText?: string;
};

export class CodexCliProvider implements CodexProvider {
  constructor(private readonly config: CodexCliConfig) {}

  async createThread(input: CreateCodexThreadInput): Promise<string> {
    return this.runCodexUntilThreadStarted(["exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only", "-"], {
      cwd: input.discussion.projectPath,
      prompt: buildInitialDiscussionPrompt(input.discussion)
    });
  }

  buildPrompt(input: CodexTurnInput): string {
    return buildDiscussionTurnPrompt(input.discussion, input.utterances, input.memoryContext, input.guidance);
  }

  async respond(input: CodexTurnInput): Promise<string> {
    if (!input.discussion.codexThreadId) {
      throw new Error("当前讨论缺少 Codex thread_id，无法续接会话。");
    }

    const result = await this.runCodex(["exec", "resume", "--json", "--skip-git-repo-check", input.discussion.codexThreadId, "-"], {
      cwd: input.discussion.projectPath,
      prompt: this.buildPrompt(input)
    });

    if (!result.finalText) {
      throw new Error("Codex CLI 未返回最终回复。");
    }

    return result.finalText;
  }

  async completePrompt(input: { prompt: string; cwd?: string }): Promise<string> {
    const result = await this.runCodex(["exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only", "-"], {
      cwd: input.cwd ?? process.cwd(),
      prompt: input.prompt
    });

    if (!result.finalText) {
      throw new Error("Codex CLI 未返回最终回复。");
    }

    return result.finalText;
  }

  private runCodex(args: string[], input: { cwd: string; prompt: string }): Promise<CodexRunResult> {
    const commandArgs = this.config.model ? [...args.slice(0, 1), "--model", this.config.model, ...args.slice(1)] : args;

    return new Promise((resolve, reject) => {
      const child = spawn(this.config.cliPath, commandArgs, {
        cwd: input.cwd,
        stdio: ["pipe", "pipe", "pipe"]
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, this.config.timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(timeout);
        if (error.code === "ENOENT") {
          reject(new Error(`Codex CLI 不存在，请检查 CODEX_CLI_PATH：${this.config.cliPath}`));
          return;
        }
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timeout);
        if (timedOut) {
          reject(new Error(`Codex CLI 超时，已超过 ${this.config.timeoutMs}ms。`));
          return;
        }
        if (code !== 0) {
          reject(new Error(`Codex CLI 执行失败（exit ${code}）：${summarizeFailure(stderr || stdout)}`));
          return;
        }

        resolve(parseCodexJsonl(stdout));
      });

      child.stdin.end(input.prompt);
    });
  }

  private runCodexUntilThreadStarted(args: string[], input: { cwd: string; prompt: string }): Promise<string> {
    const commandArgs = this.config.model ? [...args.slice(0, 1), "--model", this.config.model, ...args.slice(1)] : args;

    return new Promise((resolve, reject) => {
      const child = spawn(this.config.cliPath, commandArgs, {
        cwd: input.cwd,
        stdio: ["pipe", "pipe", "pipe"]
      });

      let stdout = "";
      let stderr = "";
      let stdoutRemainder = "";
      let settled = false;
      let timedOut = false;
      let cleanupTimer: NodeJS.Timeout | undefined;
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, this.config.timeoutMs);

      const resolveThread = (threadId: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        cleanupTimer = setTimeout(() => child.kill("SIGTERM"), this.config.timeoutMs);
        cleanupTimer.unref();
        resolve(threadId);
      };

      const rejectOnce = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      };

      child.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stdout += text;
        stdoutRemainder += text;
        const lines = stdoutRemainder.split(/\r?\n/);
        stdoutRemainder = lines.pop() ?? "";

        for (const line of lines) {
          const threadId = extractThreadIdFromLine(line);
          if (threadId) {
            resolveThread(threadId);
            return;
          }
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (error: NodeJS.ErrnoException) => {
        if (cleanupTimer) clearTimeout(cleanupTimer);
        if (error.code === "ENOENT") {
          rejectOnce(new Error(`Codex CLI 不存在，请检查 CODEX_CLI_PATH：${this.config.cliPath}`));
          return;
        }
        rejectOnce(error);
      });
      child.on("close", (code) => {
        clearTimeout(timeout);
        if (cleanupTimer) clearTimeout(cleanupTimer);
        if (settled) return;
        if (timedOut) {
          rejectOnce(new Error(`Codex CLI 超时，已超过 ${this.config.timeoutMs}ms。`));
          return;
        }

        const result = parseCodexJsonl(stdout);
        if (result.threadId) {
          resolveThread(result.threadId);
          return;
        }

        if (code !== 0) {
          rejectOnce(new Error(`Codex CLI 执行失败（exit ${code}）：${summarizeFailure(stderr || stdout)}`));
          return;
        }
        rejectOnce(new Error("Codex CLI 未返回 thread_id。"));
      });

      child.stdin.end(input.prompt);
    });
  }
}

function summarizeFailure(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.at(-1) ?? "没有错误输出。";
}

function extractThreadIdFromLine(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return undefined;

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return extractThreadId(parsed as Record<string, unknown>);
  } catch {
    return undefined;
  }
}
