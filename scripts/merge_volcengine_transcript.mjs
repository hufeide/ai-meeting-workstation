import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const [resultsDir, outputPath, sourceLabel = "本地录音文件"] = process.argv.slice(2);
if (!resultsDir || !outputPath) {
  throw new Error("用法：node scripts/merge_volcengine_transcript.mjs <API结果目录> <输出Markdown> [来源说明]");
}

const segmentOffsets = [0, 900_000, 1_800_000, 2_700_000];
const parts = [];
for (let index = 0; index < segmentOffsets.length; index += 1) {
  const stem = `segment-${String(index).padStart(2, "0")}`;
  const result = JSON.parse(await readFile(join(resultsDir, `${stem}.json`), "utf8"));
  const utterances = Array.isArray(result.result?.utterances) ? result.result.utterances : [];
  for (const utterance of utterances) {
    const text = String(utterance.text || "").trim();
    if (!text) continue;
    const startMs = segmentOffsets[index] + Number(utterance.start_time || 0);
    const speaker = normalizeSpeaker(utterance);
    parts.push(`[${formatTime(startMs)}] ${speaker}：${text}`);
  }
}

await mkdir(new URL(".", `file://${outputPath}`).pathname, { recursive: true }).catch(() => {});
const markdown = [
  "# 火山引擎录音文件识别 2.0 完整转写",
  "",
  `- 来源：${sourceLabel}`,
  "- 模型：豆包录音文件识别模型 2.0（`volc.seedasr.auc`）",
  "- 原始时长：46:13.973",
  "- 说明：为满足上传限制，本机切成四段后识别；下列时间戳已还原为整段录音时间。说话人编号由各分段模型独立判断，跨分段不保证身份编号一致。",
  "",
  ...parts,
  ""
].join("\n");
await writeFile(outputPath, markdown, "utf8");
console.log(JSON.stringify({ lineCount: parts.length, outputPath }, null, 2));

function normalizeSpeaker(utterance) {
  const raw = utterance.speaker ?? utterance.speaker_id ?? utterance.additions?.speaker;
  if (raw === undefined || raw === null || raw === "") return "说话人（未标注）";
  return `说话人 ${raw}`;
}

function formatTime(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
}
