import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type AsrEventLogEntry = {
  timestamp: string;
  direction: "client" | "server";
  eventType: string;
  requestId?: string;
  logId?: string;
  payloadSummary: string;
  rawPayload?: unknown;
};

export class AsrEventLogger {
  constructor(private readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
  }

  append(entry: Omit<AsrEventLogEntry, "timestamp">): void {
    appendFileSync(
      this.filePath,
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        ...entry
      })}\n`
    );
  }
}

export function summarizePayload(payload: unknown): string {
  if (Buffer.isBuffer(payload)) return `${payload.byteLength} bytes`;
  if (payload === undefined || payload === null) return "empty";
  if (typeof payload === "string") return `${payload.length} chars`;
  if (typeof payload === "object") return Object.keys(payload as Record<string, unknown>).join(", ") || "object";
  return String(payload);
}

export function rawPayloadIfSmall(payload: unknown, maxLength = 4000): unknown {
  if (payload === undefined || payload === null) return undefined;
  if (Buffer.isBuffer(payload)) return payload.byteLength <= maxLength ? payload.toString("base64") : undefined;
  const serialized = typeof payload === "string" ? payload : JSON.stringify(payload);
  return serialized.length <= maxLength ? payload : undefined;
}
