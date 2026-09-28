import type {
  AiFeedbackRating,
  AiTurnDto,
  AsrProviderType,
  BrainProviderType,
  CustomerDetailDto,
  CustomerSummaryDto,
  DemoBootstrapDto,
  DemoFallbackResultDto,
  DiscussionDetailDto,
  DiscussionSummaryDto,
  MemoryDraftDto,
  PublicAppSettingsDto,
  SpeakerBindingDto,
  WorkspaceDataScope
} from "../../../shared/types";

export type AppConfigDto = {
  defaultProjectPath: string;
  defaultMode: "mock" | "real";
  asrConfigured: boolean;
  codexProvider: "mock" | "cli";
  settings: PublicAppSettingsDto;
};

type CreateDiscussionInput = {
  background: string;
  customerId?: string;
  projectPath: string;
  participants: Array<{
    displayName: string;
  }>;
  asrProvider?: AsrProviderType;
  brainProvider?: BrainProviderType;
  brainModel?: string;
  mode?: "mock" | "real";
};

export function getAppConfig(): Promise<AppConfigDto> {
  return requestJson<AppConfigDto>("/api/config");
}

function scopedApiPath(scope: WorkspaceDataScope, path: string): string {
  return scope === "demo" ? `/api/demo${path}` : `/api${path}`;
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers
    }
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as ApiErrorPayload | null;
    throw new Error(formatApiError(payload, response.status));
  }

  return response.json() as Promise<T>;
}

type ApiErrorPayload = {
  error?: unknown;
  errorMessage?: unknown;
};

function formatApiError(payload: ApiErrorPayload | null, status: number): string {
  const directMessage = readMessage(payload?.errorMessage) ?? readMessage(payload?.error);
  if (directMessage) return directMessage;

  const flattenedError = payload?.error;
  if (isZodFlattenedError(flattenedError)) {
    const messages = [
      ...flattenedError.formErrors.map(translateValidationMessage),
      ...Object.entries(flattenedError.fieldErrors).flatMap(([field, errors]) =>
        errors.map((message) => `${fieldLabel(field)}：${translateValidationMessage(message)}`)
      )
    ];
    if (messages.length > 0) return messages.join("；");
  }

  return `请求失败：${status}`;
}

function readMessage(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isZodFlattenedError(value: unknown): value is {
  formErrors: string[];
  fieldErrors: Record<string, string[]>;
} {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { formErrors?: unknown; fieldErrors?: unknown };
  return Array.isArray(candidate.formErrors) && Boolean(candidate.fieldErrors) && typeof candidate.fieldErrors === "object";
}

function fieldLabel(field: string): string {
  const labels: Record<string, string> = {
    title: "标题",
    topic: "主题",
    background: "背景",
    projectPath: "Codex 项目目录",
    participants: "参与人",
    mode: "转写配置",
    customerId: "客户",
    asrProvider: "转写后端",
    brainProvider: "大脑后端",
    brainModel: "模型"
  };
  return labels[field] ?? field;
}

function translateValidationMessage(message: string): string {
  const messages: Record<string, string> = {
    "background is required": "请填写讨论背景",
    "projectPath is required": "请填写 Codex 项目目录",
    "displayName is required": "请填写参与人名称",
    "at least two participants are required": "请至少填写两位参与人"
  };
  return messages[message] ?? message;
}

export function createDiscussion(input: CreateDiscussionInput, scope: WorkspaceDataScope = "normal"): Promise<DiscussionDetailDto> {
  return requestJson<DiscussionDetailDto>(scopedApiPath(scope, "/discussions"), {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function getSettings(): Promise<PublicAppSettingsDto> {
  return requestJson<PublicAppSettingsDto>("/api/settings");
}

export function saveSettings(input: Partial<PublicAppSettingsDto> & {
  deepseekApiKey?: string;
  openaiApiKey?: string;
  volcengineApiKey?: string;
}): Promise<PublicAppSettingsDto> {
  return requestJson<PublicAppSettingsDto>("/api/settings", {
    method: "PUT",
    body: JSON.stringify(input)
  });
}

export function listCustomers(scope: WorkspaceDataScope = "normal"): Promise<CustomerSummaryDto[]> {
  return requestJson<CustomerSummaryDto[]>(scopedApiPath(scope, "/customers"));
}

export function getCustomer(customerId: string, scope: WorkspaceDataScope = "normal"): Promise<CustomerDetailDto> {
  return requestJson<CustomerDetailDto>(scopedApiPath(scope, `/customers/${encodeURIComponent(customerId)}`));
}

export function saveCustomer(input: {
  id: string;
  displayName: string;
  profile: string;
  recentCount: number;
}, scope: WorkspaceDataScope = "normal"): Promise<CustomerDetailDto> {
  return requestJson<CustomerDetailDto>(scopedApiPath(scope, "/customers"), {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function listDiscussions(scope: WorkspaceDataScope = "normal"): Promise<DiscussionSummaryDto[]> {
  return requestJson<DiscussionSummaryDto[]>(scopedApiPath(scope, "/discussions"));
}

export function getDiscussion(id: string, scope: WorkspaceDataScope = "normal"): Promise<DiscussionDetailDto> {
  return requestJson<DiscussionDetailDto>(scopedApiPath(scope, `/discussions/${id}`));
}

export function bindSpeaker(input: {
  discussionId: string;
  speakerLabel: string;
  participantId: string;
}, scope: WorkspaceDataScope = "normal"): Promise<SpeakerBindingDto> {
  return requestJson<SpeakerBindingDto>(scopedApiPath(scope, `/discussions/${input.discussionId}/speaker-bindings`), {
    method: "POST",
    body: JSON.stringify({
      speakerLabel: input.speakerLabel,
      participantId: input.participantId
    })
  });
}

export function triggerAiTurn(discussionId: string, guidance?: string, scope: WorkspaceDataScope = "normal"): Promise<AiTurnDto> {
  return requestJson<AiTurnDto>(scopedApiPath(scope, `/discussions/${discussionId}/ai-turns`), {
    method: "POST",
    body: JSON.stringify({
      contextMode: "since_last_ai_turn",
      guidance: guidance?.trim() || undefined
    })
  });
}

export async function uploadAudioFile(input: {
  discussionId: string;
  file: File;
}, scope: WorkspaceDataScope = "normal"): Promise<{ transcript: string; utteranceCount: number; transcriptPath: string; discussion: DiscussionDetailDto }> {
  const response = await fetch(
    `${scopedApiPath(scope, `/discussions/${input.discussionId}/audio-upload`)}?filename=${encodeURIComponent(input.file.name)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "x-filename": input.file.name
      },
      body: await input.file.arrayBuffer()
    }
  );
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as ApiErrorPayload | null;
    throw new Error(formatApiError(payload, response.status));
  }
  return response.json() as Promise<{ transcript: string; utteranceCount: number; transcriptPath: string; discussion: DiscussionDetailDto }>;
}

export function markAiTurnFeedback(input: {
  discussionId: string;
  aiTurnId: string;
  rating: AiFeedbackRating;
}, scope: WorkspaceDataScope = "normal"): Promise<AiTurnDto> {
  return requestJson<AiTurnDto>(scopedApiPath(scope, `/discussions/${input.discussionId}/ai-turns/${input.aiTurnId}/feedback`), {
    method: "POST",
    body: JSON.stringify({ rating: input.rating })
  });
}

export function draftMemory(discussionId: string, scope: WorkspaceDataScope = "normal"): Promise<MemoryDraftDto> {
  return requestJson<MemoryDraftDto>(scopedApiPath(scope, `/discussions/${discussionId}/memory-draft`), {
    method: "POST"
  });
}

export function confirmMemory(input: { discussionId: string; content: string }, scope: WorkspaceDataScope = "normal"): Promise<{
  memory: unknown;
  customer: CustomerDetailDto;
}> {
  return requestJson<{ memory: unknown; customer: CustomerDetailDto }>(scopedApiPath(scope, `/discussions/${input.discussionId}/memory-draft/confirm`), {
    method: "POST",
    body: JSON.stringify({ content: input.content })
  });
}

export function endDiscussion(discussionId: string, scope: WorkspaceDataScope = "normal"): Promise<DiscussionDetailDto> {
  return requestJson<DiscussionDetailDto>(scopedApiPath(scope, `/discussions/${discussionId}/end`), {
    method: "POST"
  });
}

export function deleteDiscussion(discussionId: string, scope: WorkspaceDataScope = "normal"): Promise<{ deleted: boolean }> {
  return requestJson<{ deleted: boolean }>(scopedApiPath(scope, `/discussions/${discussionId}`), {
    method: "DELETE"
  });
}

export function deleteDiscussionAudio(discussionId: string, scope: WorkspaceDataScope = "normal"): Promise<DiscussionDetailDto> {
  return requestJson<DiscussionDetailDto>(scopedApiPath(scope, `/discussions/${discussionId}/audio`), {
    method: "DELETE"
  });
}

export function discussionMarkdownExportUrl(discussionId: string, scope: WorkspaceDataScope = "normal"): string {
  return scopedApiPath(scope, `/discussions/${discussionId}/export/markdown`);
}

export function discussionPackageExportUrl(discussionId: string, scope: WorkspaceDataScope = "normal"): string {
  return scopedApiPath(scope, `/discussions/${discussionId}/export/package`);
}

export function bootstrapDemoMode(): Promise<DemoBootstrapDto> {
  return requestJson<DemoBootstrapDto>("/api/demo/bootstrap", { method: "POST" });
}

export function resetDemoMode(): Promise<DemoBootstrapDto> {
  return requestJson<DemoBootstrapDto>("/api/demo/reset", { method: "POST" });
}

export function loadDemoFallbackAudio(discussionId: string): Promise<DemoFallbackResultDto> {
  return requestJson<DemoFallbackResultDto>(`/api/demo/discussions/${discussionId}/fallback-audio`, { method: "POST" });
}
