import { z } from "zod";

export const discussionModeSchema = z.enum(["mock", "real"]);
export const asrProviderSchema = z.enum(["mock", "volcengine", "volcengine-file", "funasr", "funasr-realtime"]);
export const brainProviderSchema = z.enum(["mock", "codex-cli", "claude-cli", "deepseek", "openai", "local-qwen"]);

export const createDiscussionSchema = z.object({
  title: z.string().trim().optional(),
  topic: z.string().trim().optional(),
  background: z.string().trim().min(1, "background is required"),
  projectPath: z.string().trim().min(1, "projectPath is required"),
  customerId: z.string().trim().optional(),
  asrProvider: asrProviderSchema.optional(),
  brainProvider: brainProviderSchema.optional(),
  brainModel: z.string().trim().optional(),
  participants: z
    .array(
      z.object({
        displayName: z.string().trim().min(1, "displayName is required")
      })
    )
    .min(2, "at least two participants are required"),
  mode: discussionModeSchema.default("real")
}).transform((input) => {
  const fallbackTopic = input.background.slice(0, 48);
  return {
    ...input,
    title: input.title || "讨论会话",
    topic: input.topic || fallbackTopic
  };
});

export const bindSpeakerSchema = z.object({
  speakerLabel: z.string().trim().min(1, "speakerLabel is required"),
  participantId: z.string().trim().min(1, "participantId is required")
});

export const triggerAiTurnSchema = z.object({
  contextMode: z.literal("since_last_ai_turn").default("since_last_ai_turn"),
  guidance: z.string().trim().max(300, "guidance must be 300 characters or fewer").optional()
});

export const aiFeedbackSchema = z.object({
  rating: z.enum(["useful", "bad"])
});

export const settingsUpdateSchema = z.object({
  asrProvider: asrProviderSchema.optional(),
  brainProvider: brainProviderSchema.optional(),
  brainModel: z.string().trim().optional(),
  claudeModel: z.string().trim().optional(),
  claudeFallbackModel: z.string().trim().optional(),
  codexModel: z.string().trim().optional(),
  deepseekModel: z.string().trim().optional(),
  openaiModel: z.string().trim().optional(),
  volcengineResourceId: z.string().trim().optional(),
  volcengineEndpoint: z.string().trim().optional(),
  recentMemoryCount: z.number().int().min(1).max(20).optional(),
  cloudAcknowledged: z.boolean().optional(),
  deepseekApiKey: z.string().optional(),
  openaiApiKey: z.string().optional(),
  volcengineApiKey: z.string().optional()
});

export const customerProfileSchema = z.object({
  id: z.string().trim().min(1).max(64),
  displayName: z.string().trim().min(1).max(80),
  profile: z.string().trim().min(1),
  recentCount: z.number().int().min(1).max(20).default(5)
});

export const memoryDraftConfirmSchema = z.object({
  content: z.string().trim().min(1)
});

export const routeIdSchema = z.object({
  id: z.string().trim().min(1)
});

export type CreateDiscussionRequest = z.infer<typeof createDiscussionSchema>;
export type BindSpeakerRequest = z.infer<typeof bindSpeakerSchema>;
export type TriggerAiTurnRequest = z.infer<typeof triggerAiTurnSchema>;
export type AiFeedbackRequest = z.infer<typeof aiFeedbackSchema>;
export type SettingsUpdateRequest = z.infer<typeof settingsUpdateSchema>;
export type CustomerProfileRequest = z.infer<typeof customerProfileSchema>;
export type MemoryDraftConfirmRequest = z.infer<typeof memoryDraftConfirmSchema>;
