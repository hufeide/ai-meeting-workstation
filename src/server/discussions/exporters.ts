import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { isUsableAiTurn } from "../../shared/aiTurns";
import { AI_RESPONSE_TRUNCATED_NOTICE } from "../../shared/messages";
import type { AudioAssetDto, DiscussionDetailDto, UtteranceDto } from "../../shared/types";
import type { StoragePaths } from "../storage/paths";

export type DiscussionExportManifest = {
  exportVersion: 1;
  appVersion: string;
  discussionId: string;
  createdAt: string;
  endedAt?: string;
  participantCount: number;
  utteranceCount: number;
  aiTurnCount: number;
  includedFiles: string[];
};

export function discussionExportFileStem(discussion: DiscussionDetailDto): string {
  const date = discussion.createdAt.slice(0, 10);
  return `discussion-${date}-${discussion.id.slice(0, 8)}`;
}

export function renderDiscussionMarkdown(discussion: DiscussionDetailDto): string {
  const lines = [
    "# 讨论复盘",
    "",
    "## 背景",
    "",
    discussion.background || "无背景说明。",
    "",
    "## 参与人",
    "",
    ...discussion.participants.map((participant) => `- ${participant.displayName}`),
    "",
    "## 时间线",
    ""
  ];

  for (const item of timelineItems(discussion)) {
    lines.push(`### ${formatLocalTime(item.createdAt)} ${item.speaker}`, "", item.text, "");
  }

  lines.push("## Codex Thread", "", discussion.codexThreadId ?? "无 Codex thread id。", "");
  return `${lines.join("\n").trim()}\n`;
}

export function createDiscussionPackage(discussion: DiscussionDetailDto, storagePaths: StoragePaths): Buffer {
  const markdown = renderDiscussionMarkdown(discussion);
  const discussionJson = JSON.stringify({ discussion }, null, 2);
  const files: Array<{ path: string; data: Buffer }> = [
    { path: "transcript.md", data: Buffer.from(markdown, "utf8") },
    { path: "discussion.json", data: Buffer.from(discussionJson, "utf8") }
  ];

  for (const asset of discussion.audioAssets) {
    const assetPath = resolveAudioPath(asset, storagePaths);
    if (assetPath && existsSync(assetPath)) {
      files.push({ path: `audio/${basename(assetPath)}`, data: readFileSync(assetPath) });
    }
  }

  const manifest: DiscussionExportManifest = {
    exportVersion: 1,
    appVersion: "0.1.0",
    discussionId: discussion.id,
    createdAt: discussion.createdAt,
    endedAt: discussion.endedAt,
    participantCount: discussion.participants.length,
    utteranceCount: discussion.utterances.length,
    aiTurnCount: discussion.aiTurns.length,
    includedFiles: ["manifest.json", ...files.map((file) => file.path)]
  };
  files.unshift({ path: "manifest.json", data: Buffer.from(JSON.stringify(manifest, null, 2), "utf8") });

  return createStoredZip(files);
}

function timelineItems(discussion: DiscussionDetailDto): Array<{ createdAt: string; speaker: string; text: string }> {
  const utterances = discussion.utterances
    .filter((utterance) => utterance.isFinal)
    .map((utterance) => ({
      createdAt: utterance.createdAt,
      speaker: speakerName(discussion, utterance),
      text: utterance.text
    }));
  const aiTurns = discussion.aiTurns
    .filter(isUsableAiTurn)
    .map((turn) => ({
      createdAt: turn.completedAt ?? turn.createdAt,
      speaker: turn.status === "truncated" ? "Codex（回复未完整生成）" : "Codex",
      text:
        turn.status === "truncated"
          ? `${turn.response ?? ""}\n\n> ${AI_RESPONSE_TRUNCATED_NOTICE}`
          : turn.response ?? ""
    }));

  return [...utterances, ...aiTurns].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function speakerName(discussion: DiscussionDetailDto, utterance: UtteranceDto): string {
  const participant = discussion.participants.find((item) => item.id === utterance.participantId);
  return participant?.displayName ?? utterance.speakerLabel;
}

function formatLocalTime(value: string): string {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function resolveAudioPath(asset: AudioAssetDto, storagePaths: StoragePaths): string | undefined {
  if (asset.path.startsWith(storagePaths.dataDir) || asset.path.startsWith("/")) return asset.path;
  return join(storagePaths.dataDir, asset.path);
}

function createStoredZip(files: Array<{ path: string; data: Buffer }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.path, "utf8");
    const crc = crc32(file.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(file.data.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, file.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(file.data.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + file.data.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let index = 0; index < 8; index += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
