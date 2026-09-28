export type DiscussionStatus = "draft" | "active" | "ended";
export type DiscussionMode = "mock" | "real";
export type AsrProviderType = "mock" | "volcengine" | "volcengine-file" | "funasr";
export type BrainProviderType = "mock" | "codex-cli" | "claude-cli" | "deepseek" | "openai" | "local-qwen";
export type UtteranceSource = "mock" | "volcengine" | "volcengine-file" | "funasr" | "upload";
export type AiTurnStatus = "pending" | "streaming" | "completed" | "truncated" | "failed";
export type AiTurnType = "summary" | "challenge" | "risk" | "next_step";
export type AiFeedbackRating = "useful" | "bad";

export type ParticipantDto = {
  id: string;
  discussionId: string;
  displayName: string;
  role?: string;
  sortOrder: number;
};

export type DiscussionDto = {
  id: string;
  title: string;
  topic: string;
  background?: string;
  projectPath: string;
  mode: DiscussionMode;
  customerId?: string;
  asrProvider?: AsrProviderType;
  brainProvider?: BrainProviderType;
  brainModel?: string;
  codexThreadId?: string;
  status: DiscussionStatus;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  participants: ParticipantDto[];
};

export type DiscussionDetailDto = DiscussionDto & {
  speakerBindings: SpeakerBindingDto[];
  utterances: UtteranceDto[];
  aiTurns: AiTurnDto[];
  audioAssets: AudioAssetDto[];
};

export type DiscussionSummaryDto = Pick<
  DiscussionDto,
  "id" | "title" | "topic" | "status" | "mode" | "asrProvider" | "createdAt" | "startedAt" | "endedAt"
> & {
  finalUtteranceCount: number;
  aiTurnCount: number;
  participantCount: number;
  participantNames: string[];
  hasAudioAssets: boolean;
};

export type SpeakerBindingDto = {
  id: string;
  discussionId: string;
  speakerLabel: string;
  participantId: string;
  createdAt: string;
  updatedAt: string;
};

export type UtteranceDto = {
  id: string;
  discussionId: string;
  speakerLabel: string;
  participantId?: string;
  text: string;
  startMs?: number;
  endMs?: number;
  isFinal: boolean;
  source: UtteranceSource;
  createdAt: string;
};

export type AiTurnDto = {
  id: string;
  discussionId: string;
  turnType?: AiTurnType;
  codexThreadId?: string;
  triggerStartUtteranceId?: string;
  triggerEndUtteranceId?: string;
  prompt: string;
  response?: string;
  status: AiTurnStatus;
  errorMessage?: string;
  createdAt: string;
  completedAt?: string;
  feedbackRating?: AiFeedbackRating;
  feedbackCreatedAt?: string;
};

export type AudioAssetDto = {
  id: string;
  discussionId: string;
  path: string;
  format: string;
  durationMs?: number;
  source: "browser";
  createdAt: string;
};

export type PublicAppSettingsDto = {
  asrProvider: AsrProviderType;
  brainProvider: BrainProviderType;
  brainModel: string;
  claudeModel: string;
  claudeFallbackModel?: string;
  codexModel?: string;
  deepseekModel: string;
  openaiModel: string;
  volcengineResourceId: string;
  volcengineEndpoint: string;
  recentMemoryCount: number;
  cloudAcknowledged: boolean;
  keys: {
    deepseek: boolean;
    openai: boolean;
    volcengine: boolean;
  };
  cli: {
    claudePath: string;
    codexPath: string;
  };
  storage: {
    settingsPath: string;
    customersDir: string;
  };
};

export type CustomerSummaryDto = {
  id: string;
  displayName: string;
  memoryCount: number;
  updatedAt?: string;
};

export type RollingMemoryDto = {
  id: string;
  customerId: string;
  sourceDiscussionId: string;
  content: string;
  createdAt: string;
};

export type CustomerDetailDto = CustomerSummaryDto & {
  profile: string;
  recentCount: number;
  recentMemories: RollingMemoryDto[];
  speakerMap: Record<string, string>;
  paths: {
    profile: string;
    rollingMemory: string;
    draftsDir: string;
  };
};

export type MemoryDraftDto = {
  id: string;
  customerId: string;
  discussionId: string;
  content: string;
  status: "draft" | "confirmed";
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceDataScope = "normal" | "demo";

export type DemoBootstrapDto = {
  mode: "demo";
  customer: CustomerDetailDto;
  meeting: {
    background: string;
    participants: Array<{
      displayName: string;
    }>;
  };
  fallbackAudio: {
    available: boolean;
    filename: string;
    label: string;
  };
  isolation: {
    database: "separate";
    customers: "separate";
    recordings: "separate";
  };
};

export type DemoFallbackResultDto = {
  alreadyLoaded: boolean;
  transcript: string;
  utteranceCount: number;
  transcriptPath?: string;
  discussion: DiscussionDetailDto;
};
