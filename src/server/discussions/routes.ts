import { raw, Router } from "express";
import { existsSync, rmSync } from "node:fs";
import {
  aiFeedbackSchema,
  bindSpeakerSchema,
  createDiscussionSchema,
  memoryDraftConfirmSchema,
  routeIdSchema,
  triggerAiTurnSchema
} from "../../shared/schemas";
import type { FunasrFileTranscriber } from "../asr/funasrFile";
import type { VolcengineFileTranscriber } from "../asr/volcengineFile";
import type { MockAsrService } from "../asr/mockAsr";
import type { BrainProviderRegistry } from "../codex/brainRegistry";
import { TruncatedAiResponseError } from "../codex/provider";
import type { LocalSettingsStore } from "../settings/localSettings";
import { modelForProvider } from "../settings/localSettings";
import type { MemoryStore } from "../memory/memoryStore";
import type { StoragePaths } from "../storage/paths";
import type { EventHub } from "../ws/eventHub";
import { createDiscussionPackage, discussionExportFileStem, renderDiscussionMarkdown } from "./exporters";
import type { DiscussionRepository } from "./repository";

export function createDiscussionRouter(deps: {
  repository: DiscussionRepository;
  mockAsr: MockAsrService;
  brainRegistry: BrainProviderRegistry;
  settingsStore: LocalSettingsStore;
  memoryStore: MemoryStore;
  funasrFileTranscriber: FunasrFileTranscriber;
  getVolcengineFileTranscriber: () => VolcengineFileTranscriber;
  eventHub: EventHub;
  storagePaths: StoragePaths;
}): Router {
  const router = Router();

  router.post("/", async (request, response) => {
    const parsed = createDiscussionSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    try {
      const settings = deps.settingsStore.load();
      const brainProvider = parsed.data.brainProvider ?? settings.brainProvider;
      const asrProvider = parsed.data.asrProvider ?? settings.asrProvider;
      const brainModel = parsed.data.brainModel || modelForProvider(settings, brainProvider);
      const createInput = { ...parsed.data, brainProvider, asrProvider, brainModel };
      const provider = deps.brainRegistry.getProvider(brainProvider, brainModel);
      const codexThreadId = await provider.createThread({ discussion: createInput });
      const discussion = deps.repository.createDiscussion(createInput, codexThreadId);
      response.status(201).json(discussion);
    } catch (error) {
      response.status(503).json({ error: error instanceof Error ? error.message : "AI 大脑会话创建失败。" });
    }
  });

  router.get("/", (_request, response) => {
    response.json(deps.repository.listDiscussionSummaries());
  });

  router.get("/:id", (request, response) => {
    const parsed = routeIdSchema.safeParse(request.params);
    if (!parsed.success) {
      response.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const discussion = deps.repository.getDiscussion(parsed.data.id);
    if (!discussion) {
      response.status(404).json({ error: "discussion not found" });
      return;
    }

    response.json(discussion);
  });

  router.post("/:id/speaker-bindings", (request, response) => {
    const params = routeIdSchema.safeParse(request.params);
    const body = bindSpeakerSchema.safeParse(request.body);
    if (!params.success) {
      response.status(400).json({ error: params.error.flatten() });
      return;
    }
    if (!body.success) {
      response.status(400).json({ error: body.error.flatten() });
      return;
    }

    const binding = deps.repository.bindSpeaker(params.data.id, body.data);
    const discussion = deps.repository.getDiscussionOrThrow(params.data.id);
    if (discussion.customerId) {
      const participant = discussion.participants.find((item) => item.id === body.data.participantId);
      if (participant) deps.memoryStore.rememberSpeaker(discussion.customerId, body.data.speakerLabel, participant.displayName);
    }
    deps.eventHub.publish(params.data.id, { type: "speaker.binding.updated", binding });
    deps.eventHub.publish(params.data.id, { type: "discussion.updated", discussion });
    response.json(binding);
  });

  router.post("/:id/audio-upload", raw({ type: "*/*", limit: "200mb" }), async (request, response) => {
    const parsed = routeIdSchema.safeParse(request.params);
    if (!parsed.success) {
      response.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    if (!Buffer.isBuffer(request.body) || request.body.byteLength === 0) {
      response.status(400).json({ error: "请上传非空音频文件。" });
      return;
    }

    const discussion = deps.repository.getDiscussion(parsed.data.id);
    if (!discussion) {
      response.status(404).json({ error: "discussion not found" });
      return;
    }
    if (discussion.asrProvider !== "volcengine-file" && discussion.asrProvider !== "funasr") {
      response.status(400).json({ error: "该讨论不是录音文件识别档，不支持上传转写。" });
      return;
    }

    try {
      const filename =
        readStringHeader(request.headers["x-filename"]) ||
        new URLSearchParams(String(request.url).split("?")[1] || "").get("filename") ||
        "upload.wav";
      const transcriber =
        discussion.asrProvider === "volcengine-file"
          ? deps.getVolcengineFileTranscriber()
          : deps.funasrFileTranscriber;
      const result = await transcriber.transcribeUpload({
        discussionId: discussion.id,
        filename,
        audio: request.body
      });
      const updated = deps.repository.getDiscussionOrThrow(discussion.id);
      deps.eventHub.publish(discussion.id, { type: "discussion.updated", discussion: updated });
      response.status(201).json({ ...result, discussion: updated });
    } catch (error) {
      response.status(503).json({ error: error instanceof Error ? error.message : "录音文件识别失败。" });
    }
  });

  router.get("/:id/export/markdown", (request, response) => {
    const parsed = routeIdSchema.safeParse(request.params);
    if (!parsed.success) {
      response.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const discussion = deps.repository.getDiscussion(parsed.data.id);
    if (!discussion) {
      response.status(404).json({ error: "discussion not found" });
      return;
    }

    response
      .status(200)
      .type("text/markdown; charset=utf-8")
      .attachment(`${discussionExportFileStem(discussion)}.md`)
      .send(renderDiscussionMarkdown(discussion));
  });

  router.get("/:id/export/package", (request, response) => {
    const parsed = routeIdSchema.safeParse(request.params);
    if (!parsed.success) {
      response.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const discussion = deps.repository.getDiscussion(parsed.data.id);
    if (!discussion) {
      response.status(404).json({ error: "discussion not found" });
      return;
    }

    response
      .status(200)
      .type("application/zip")
      .attachment(`${discussionExportFileStem(discussion)}.zip`)
      .send(createDiscussionPackage(discussion, deps.storagePaths));
  });

  router.post("/:id/ai-turns", async (request, response) => {
    const params = routeIdSchema.safeParse(request.params);
    const body = triggerAiTurnSchema.safeParse(request.body);
    if (!params.success) {
      response.status(400).json({ error: params.error.flatten() });
      return;
    }
    if (!body.success) {
      response.status(400).json({ error: body.error.flatten() });
      return;
    }

    const discussion = deps.repository.getDiscussion(params.data.id);
    if (!discussion) {
      response.status(404).json({ error: "discussion not found" });
      return;
    }

    const utterances = deps.repository.listFinalUtterancesSinceLastAiTurn(discussion.id);
    const provider = deps.brainRegistry.getProvider(discussion.brainProvider, discussion.brainModel);
    const settings = deps.settingsStore.load();
    const memoryContext = deps.memoryStore.buildPromptContext(discussion.customerId, settings.recentMemoryCount);
    const turnInput = { discussion, utterances, memoryContext, guidance: body.data.guidance };
    const prompt = provider.buildPrompt(turnInput);
    const triggerStartUtteranceId = utterances.at(0)?.id;
    const triggerEndUtteranceId = utterances.at(-1)?.id;

    try {
      const responseText = await provider.respond(turnInput);
      const aiTurn = deps.repository.createCompletedAiTurn({
        discussionId: discussion.id,
        codexThreadId: discussion.codexThreadId,
        prompt,
        response: responseText,
        triggerStartUtteranceId,
        triggerEndUtteranceId
      });

      deps.eventHub.publish(discussion.id, { type: "codex.turn.completed", aiTurn });
      response.status(201).json(aiTurn);
    } catch (error) {
      if (error instanceof TruncatedAiResponseError) {
        const aiTurn = deps.repository.createTruncatedAiTurn({
          discussionId: discussion.id,
          codexThreadId: discussion.codexThreadId,
          prompt,
          response: error.partialResponse,
          triggerStartUtteranceId,
          triggerEndUtteranceId
        });

        deps.eventHub.publish(discussion.id, { type: "codex.turn.truncated", aiTurn });
        response.status(201).json(aiTurn);
        return;
      }
      const message = error instanceof Error ? error.message : "AI 大脑发言失败。";
      const aiTurn = deps.repository.createFailedAiTurn({
        discussionId: discussion.id,
        codexThreadId: discussion.codexThreadId,
        prompt,
        errorMessage: message,
        triggerStartUtteranceId,
        triggerEndUtteranceId
      });

      deps.eventHub.publish(discussion.id, { type: "codex.turn.failed", aiTurnId: aiTurn.id, message });
      response.status(503).json(aiTurn);
    }
  });

  router.post("/:id/ai-turns/:aiTurnId/feedback", (request, response) => {
    const params = routeIdSchema.safeParse({ id: request.params.id });
    const body = aiFeedbackSchema.safeParse(request.body);
    if (!params.success) {
      response.status(400).json({ error: params.error.flatten() });
      return;
    }
    if (!body.success) {
      response.status(400).json({ error: body.error.flatten() });
      return;
    }
    try {
      const aiTurn = deps.repository.markAiTurnFeedback({
        discussionId: params.data.id,
        aiTurnId: request.params.aiTurnId,
        rating: body.data.rating
      });
      response.json(aiTurn);
    } catch (error) {
      response.status(404).json({ error: error instanceof Error ? error.message : "AI 发言不存在。" });
    }
  });

  router.post("/:id/memory-draft", async (request, response) => {
    const parsed = routeIdSchema.safeParse(request.params);
    if (!parsed.success) {
      response.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const discussion = deps.repository.getDiscussion(parsed.data.id);
    if (!discussion) {
      response.status(404).json({ error: "discussion not found" });
      return;
    }
    if (!discussion.customerId) {
      response.status(400).json({ error: "当前会议未选择客户，无法沉淀客户记忆。" });
      return;
    }
    try {
      const provider = deps.brainRegistry.getProvider(discussion.brainProvider, discussion.brainModel);
      const draftText = await provider.completePrompt({
        prompt: deps.memoryStore.buildMemoryDraftPrompt(discussion),
        cwd: discussion.projectPath
      });
      const draft = deps.memoryStore.createDraft({
        customerId: discussion.customerId,
        discussionId: discussion.id,
        content: draftText
      });
      response.status(201).json(draft);
    } catch (error) {
      response.status(503).json({ error: error instanceof Error ? error.message : "记忆草稿起草失败。" });
    }
  });

  router.post("/:id/memory-draft/confirm", (request, response) => {
    const params = routeIdSchema.safeParse(request.params);
    const body = memoryDraftConfirmSchema.safeParse(request.body);
    if (!params.success) {
      response.status(400).json({ error: params.error.flatten() });
      return;
    }
    if (!body.success) {
      response.status(400).json({ error: body.error.flatten() });
      return;
    }
    const discussion = deps.repository.getDiscussion(params.data.id);
    if (!discussion?.customerId) {
      response.status(400).json({ error: "当前会议未选择客户，无法确认客户记忆。" });
      return;
    }
    const memory = deps.memoryStore.confirmDraft({
      customerId: discussion.customerId,
      discussionId: discussion.id,
      content: body.data.content
    });
    response.json({ memory, customer: deps.memoryStore.getCustomer(discussion.customerId) });
  });

  router.post("/:id/end", (request, response) => {
    const parsed = routeIdSchema.safeParse(request.params);
    if (!parsed.success) {
      response.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    deps.mockAsr.stop(parsed.data.id);
    const discussion = deps.repository.endDiscussion(parsed.data.id);
    deps.eventHub.publish(parsed.data.id, { type: "discussion.updated", discussion });
    response.json(discussion);
  });

  router.delete("/:id/audio", (request, response) => {
    const parsed = routeIdSchema.safeParse(request.params);
    if (!parsed.success) {
      response.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const discussion = deps.repository.getDiscussion(parsed.data.id);
    if (!discussion) {
      response.status(404).json({ error: "discussion not found" });
      return;
    }

    const assets = discussion.audioAssets;
    for (const asset of assets) {
      if (existsSync(asset.path)) rmSync(asset.path, { force: true });
    }
    deps.repository.deleteAudioAssets(parsed.data.id);
    response.json(deps.repository.getDiscussionOrThrow(parsed.data.id));
  });

  router.delete("/:id", (request, response) => {
    const parsed = routeIdSchema.safeParse(request.params);
    if (!parsed.success) {
      response.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const discussion = deps.repository.getDiscussion(parsed.data.id);
    if (!discussion) {
      response.status(404).json({ error: "discussion not found" });
      return;
    }

    const discussionDir = `${deps.storagePaths.discussionsDir}/${parsed.data.id}`;
    if (existsSync(discussionDir)) rmSync(discussionDir, { recursive: true, force: true });
    const deleted = deps.repository.deleteDiscussion(parsed.data.id);
    response.json({ deleted });
  });

  return router;
}

function readStringHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}
