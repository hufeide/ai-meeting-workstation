import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { randomUUID } from "node:crypto";

const [inputPath, outputDir] = process.argv.slice(2);
if (!inputPath || !outputDir) {
  throw new Error("用法：node scripts/transcribe_volcengine_file.mjs <音频路径> <输出目录>");
}

const settingsPath = new URL("../.local-data/settings.local.json", import.meta.url);
const settings = JSON.parse(await readFile(settingsPath, "utf8"));
const apiKey = String(settings.volcengineApiKey || "").trim();
if (!apiKey) throw new Error("本机设置中缺少火山 API Key。");

const audio = await readFile(inputPath);
const format = extname(inputPath).slice(1).toLowerCase();
const taskId = randomUUID();
const resourceId = "volc.seedasr.auc";
const commonHeaders = {
  "Content-Type": "application/json",
  "X-Api-Key": apiKey,
  "X-Api-Resource-Id": resourceId,
  "X-Api-Request-Id": taskId
};

const submit = await fetch("https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit", {
  method: "POST",
  headers: { ...commonHeaders, "X-Api-Sequence": "-1" },
  body: JSON.stringify({
    user: { uid: "meeting-workstation-local" },
    audio: { format, data: audio.toString("base64") },
    request: {
      model_name: "bigmodel",
      enable_itn: true,
      enable_punc: true,
      show_utterances: true,
      enable_speaker_info: true
    }
  })
});

assertApiSuccess(submit, await submit.text(), "提交");

let result;
for (let attempt = 0; attempt < 240; attempt += 1) {
  const query = await fetch("https://openspeech.bytedance.com/api/v3/auc/bigmodel/query", {
    method: "POST",
    headers: commonHeaders,
    body: "{}"
  });
  const body = await query.text();
  const code = query.headers.get("x-api-status-code");
  if (code === "20000000") {
    result = JSON.parse(body);
    break;
  }
  if (code !== "20000001" && code !== "20000002") assertApiSuccess(query, body, "查询");
  await new Promise((resolve) => setTimeout(resolve, 3000));
}

if (!result) throw new Error("火山录音文件识别超时，任务仍未返回结果。");

await mkdir(outputDir, { recursive: true });
const stem = basename(inputPath, extname(inputPath));
const text = String(result.result?.text || "").trim();
if (!text) throw new Error("火山返回成功，但转写文字为空。");
await writeFile(join(outputDir, `${stem}.json`), `${JSON.stringify(result, null, 2)}\n`, "utf8");
await writeFile(join(outputDir, `${stem}.txt`), `${text}\n`, "utf8");

console.log(JSON.stringify({
  taskId,
  durationMs: result.audio_info?.duration,
  textLength: text.length,
  utteranceCount: result.result?.utterances?.length ?? 0,
  textPath: join(outputDir, `${stem}.txt`),
  jsonPath: join(outputDir, `${stem}.json`)
}, null, 2));

function assertApiSuccess(response, body, action) {
  const code = response.headers.get("x-api-status-code");
  if (response.ok && code === "20000000") return;
  const message = response.headers.get("x-api-message") || body.slice(0, 500) || "未知错误";
  throw new Error(`火山${action}失败：${code || response.status} ${message}`);
}
