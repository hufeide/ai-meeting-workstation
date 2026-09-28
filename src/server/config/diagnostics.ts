import { accessSync, constants, existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { resolveFunasrRuntime } from "./serverConfig";

export type DiagnosticStatus = "pass" | "warn" | "fail";

export type DiagnosticItem = {
  group: string;
  label: string;
  status: DiagnosticStatus;
  message?: string;
};

export type DiagnosticReport = {
  title: "AI Discussion Doctor";
  items: DiagnosticItem[];
  ok: boolean;
  issueCount: number;
};

export async function runDiagnostics(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): Promise<DiagnosticReport> {
  const items: DiagnosticItem[] = [];
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const appPort = readPort(env.APP_PORT ?? "8787");
  const dataDir = resolve(cwd, env.APP_DATA_DIR ?? ".local-data");

  items.push({
    group: "基础环境",
    label: "Node.js 版本满足要求",
    status: nodeMajor >= 22 ? "pass" : "fail",
    message: nodeMajor >= 22 ? undefined : `当前版本 ${process.versions.node}，需要 >=22`
  });

  const funasrRuntime = resolveFunasrRuntime(env, cwd);
  items.push({
    group: "本地 FunASR",
    label: "FunASR Python 可执行",
    status: commandWorks(funasrRuntime.pythonPath, ["--version"]) ? "pass" : "warn",
    message: commandWorks(funasrRuntime.pythonPath, ["--version"])
      ? undefined
      : `无法执行 ${funasrRuntime.pythonPath}，请检查 FUNASR_PYTHON_PATH。`
  });
  items.push({
    group: "本地 FunASR",
    label: "FunASR Python 包可导入",
    status: commandWorks(funasrRuntime.pythonPath, ["-c", "import funasr"]) ? "pass" : "warn",
    message: commandWorks(funasrRuntime.pythonPath, ["-c", "import funasr"])
      ? undefined
      : "当前 Python 环境无法导入 funasr，本地文件转写不可用。"
  });
  items.push({
    group: "本地 FunASR",
    label: "FunASR 模型缓存目录存在",
    status: existsSync(resolve(funasrRuntime.asrHome, ".modelscope_cache")) ? "pass" : "warn",
    message: existsSync(resolve(funasrRuntime.asrHome, ".modelscope_cache"))
      ? undefined
      : `未找到 ${resolve(funasrRuntime.asrHome, ".modelscope_cache")}。`
  });
  items.push({
    group: "基础环境",
    label: "npm 可用",
    status: commandWorks("npm", ["--version"]) ? "pass" : "fail",
    message: commandWorks("npm", ["--version"]) ? undefined : "请确认 npm 已安装并在 PATH 中。"
  });
  items.push({
    group: "基础环境",
    label: "当前目录为项目根目录",
    status: existsSync(resolve(cwd, "package.json")) && existsSync(resolve(cwd, "src")) ? "pass" : "fail"
  });
  items.push({
    group: "基础环境",
    label: "node_modules 已安装",
    status: existsSync(resolve(cwd, "node_modules")) ? "pass" : "fail",
    message: existsSync(resolve(cwd, "node_modules")) ? undefined : "请先运行 npm install。"
  });

  items.push({ group: "应用配置", label: ".env 已存在", status: existsSync(resolve(cwd, ".env")) ? "pass" : "warn" });
  items.push({
    group: "应用配置",
    label: "APP_HOST 有效",
    status: env.APP_HOST === undefined || env.APP_HOST.trim() ? "pass" : "fail",
    message: env.APP_HOST === undefined || env.APP_HOST.trim() ? undefined : "请在 .env 中配置 APP_HOST。"
  });
  items.push({
    group: "应用配置",
    label: "APP_PORT 有效",
    status: appPort ? "pass" : "fail",
    message: appPort ? undefined : `APP_PORT 必须是 1-65535 的数字，当前值：${env.APP_PORT ?? "8787"}`
  });
  items.push({
    group: "应用配置",
    label: "CLIENT_DEV_ORIGIN 有效",
    status: isHttpUrl(env.CLIENT_DEV_ORIGIN ?? "http://127.0.0.1:5173") ? "pass" : "fail"
  });
  items.push(writableDataDirItem(dataDir));
  items.push({
    group: "应用配置",
    label: "APP_PORT 未被占用",
    ...(await portAvailabilityStatus(env.APP_HOST || "127.0.0.1", appPort))
  });

  const codexProvider = env.CODEX_PROVIDER === "mock" ? "mock" : "cli";
  const codexPath = env.CODEX_CLI_PATH ?? "codex";
  items.push({
    group: "Codex CLI",
    label: "CODEX_PROVIDER 使用真实运行推荐值",
    status: codexProvider === "cli" ? "pass" : "warn",
    message: codexProvider === "cli" ? undefined : "仅在选择 Codex CLI 大脑时才需要配置 CLI。"
  });
  items.push({
    group: "Codex CLI",
    label: "CODEX_CLI_PATH 已配置",
    status: codexPath.trim() ? "pass" : "warn",
    message: codexPath.trim() ? undefined : "请在 .env 中配置 CODEX_CLI_PATH。"
  });
  items.push({
    group: "Codex CLI",
    label: "Codex CLI 可执行",
    status: codexPath.trim() && commandWorks(codexPath, ["--version"]) ? "pass" : "warn",
    message: codexPath.trim() && commandWorks(codexPath, ["--version"]) ? undefined : `无法执行 ${codexPath} --version，请检查 CODEX_CLI_PATH。`
  });
  items.push({
    group: "Codex CLI",
    label: "CODEX_CLI_TIMEOUT_MS 有效",
    status: isPositiveNumber(env.CODEX_CLI_TIMEOUT_MS ?? "120000") ? "pass" : "fail"
  });

  items.push({
    group: "火山 ASR",
    label: "VOLCENGINE_ASR_API_KEY 已配置",
    status: env.VOLCENGINE_ASR_API_KEY ? "pass" : "warn",
    message: "只影响火山云端 ASR；本地 FunASR 不需要此 Key。"
  });
  items.push({
    group: "火山 ASR",
    label: "VOLCENGINE_ASR_RESOURCE_ID 已配置",
    status: env.VOLCENGINE_ASR_RESOURCE_ID ? "pass" : "warn",
    message: "只影响火山实时 ASR；本地 FunASR 不需要此配置。"
  });
  items.push({
    group: "火山 ASR",
    label: "VOLCENGINE_ASR_ENDPOINT 是 WebSocket 地址",
    status: isWebSocketUrl(env.VOLCENGINE_ASR_ENDPOINT ?? "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async") ? "pass" : "fail"
  });

  const issueCount = items.filter((item) => item.status === "fail").length;
  return {
    title: "AI Discussion Doctor",
    items,
    ok: issueCount === 0,
    issueCount
  };
}

function writableDataDirItem(dataDir: string): DiagnosticItem {
  try {
    mkdirSync(dataDir, { recursive: true });
    accessSync(dataDir, constants.W_OK);
    return { group: "应用配置", label: "APP_DATA_DIR 可写", status: "pass" };
  } catch (error) {
    return {
      group: "应用配置",
      label: "APP_DATA_DIR 可写",
      status: "fail",
      message: error instanceof Error ? error.message : `无法写入 ${dataDir}`
    };
  }
}

function commandWorks(command: string, args: string[]): boolean {
  const result = spawnSync(command, args, { stdio: "ignore" });
  return result.status === 0;
}

function isPositiveNumber(value: string): boolean {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0;
}

function readPort(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : undefined;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isWebSocketUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "ws:" || url.protocol === "wss:";
  } catch {
    return false;
  }
}

function isPortAvailable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

async function portAvailabilityStatus(host: string, port: number | undefined): Promise<Pick<DiagnosticItem, "status" | "message">> {
  if (!port) {
    return { status: "warn", message: "APP_PORT 无效，无法检查端口占用。" };
  }
  return (await isPortAvailable(host, port))
    ? { status: "pass" }
    : { status: "warn", message: `端口 ${port} 可能已被占用。` };
}
