type JsonObject = Record<string, unknown>;

export type ParsedCodexJsonl = {
  threadId?: string;
  finalText?: string;
  events: JsonObject[];
};

export function parseCodexJsonl(output: string): ParsedCodexJsonl {
  const events: JsonObject[] = [];
  let threadId: string | undefined;
  let finalText: string | undefined;

  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;

    const event = parseJsonObject(trimmed);
    if (!event) continue;

    events.push(event);
    threadId = extractThreadId(event) ?? threadId;
    finalText = extractAgentText(event) ?? finalText;
  }

  return { threadId, finalText, events };
}

function parseJsonObject(value: string): JsonObject | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as JsonObject) : null;
  } catch {
    return null;
  }
}

export function extractThreadId(event: JsonObject): string | undefined {
  if (typeof event.thread_id === "string") return event.thread_id;
  if (typeof event.session_id === "string") return event.session_id;
  if (typeof event.conversation_id === "string") return event.conversation_id;
  return undefined;
}

function extractAgentText(event: JsonObject): string | undefined {
  if (event.type === "agent_message" && typeof event.text === "string") return event.text;
  if (event.type !== "item.completed") return undefined;

  const item = event.item;
  if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
  const itemObject = item as JsonObject;

  if (itemObject.type === "agent_message" && typeof itemObject.text === "string") {
    return itemObject.text;
  }

  if (itemObject.type === "message" && itemObject.role === "assistant") {
    return extractTextFromContent(itemObject.content);
  }

  return undefined;
}

function extractTextFromContent(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;

  const chunks = content
    .map((part) => {
      if (!part || typeof part !== "object" || Array.isArray(part)) return "";
      const partObject = part as JsonObject;
      if (typeof partObject.text === "string") return partObject.text;
      if (typeof partObject.output_text === "string") return partObject.output_text;
      return "";
    })
    .filter(Boolean);

  return chunks.length > 0 ? chunks.join("") : undefined;
}
