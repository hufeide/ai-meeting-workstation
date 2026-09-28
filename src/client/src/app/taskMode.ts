import type { AsrProviderType, DiscussionSummaryDto } from "../../../shared/types";

export type TaskMode = "home" | "file" | "live";

export function isFileAsrProvider(provider: AsrProviderType | undefined): boolean {
  return provider === "volcengine-file" || provider === "funasr";
}

export function taskModeForDiscussion(discussion: Pick<DiscussionSummaryDto, "asrProvider">): Exclude<TaskMode, "home"> {
  return isFileAsrProvider(discussion.asrProvider) ? "file" : "live";
}

export function transcriptionNameFromFile(filename: string): string {
  const withoutExtension = filename.replace(/\.[^.]+$/, "").trim();
  return withoutExtension || "录音转写";
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function parseKnownSpeakers(value: string): Array<{ id: string; displayName: string }> {
  const names = value.split(/[，,\n]/).map((name) => name.trim()).filter(Boolean);
  const effectiveNames = names.length > 0 ? names : ["参与人 A", "参与人 B"];
  return effectiveNames.map((displayName, index) => ({ id: `file-speaker-${index + 1}`, displayName }));
}
