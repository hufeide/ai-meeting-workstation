import { randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";
import type {
  AiTurnDto,
  AiTurnType,
  AudioAssetDto,
  DiscussionDetailDto,
  DiscussionDto,
  DiscussionSummaryDto,
  DiscussionStatus,
  ParticipantDto,
  SpeakerBindingDto,
  UtteranceDto,
  UtteranceSource
} from "../../shared/types";
import type { BindSpeakerRequest, CreateDiscussionRequest } from "../../shared/schemas";

type DiscussionRow = {
  id: string;
  title: string;
  topic: string;
  background: string | null;
  project_path: string;
  mode: DiscussionDto["mode"];
  customer_id: string | null;
  asr_provider: DiscussionDto["asrProvider"];
  brain_provider: DiscussionDto["brainProvider"];
  brain_model: string | null;
  codex_thread_id: string | null;
  status: DiscussionStatus;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
};

type ParticipantRow = {
  id: string;
  discussion_id: string;
  display_name: string;
  role: string | null;
  sort_order: number;
};

type SpeakerBindingRow = {
  id: string;
  discussion_id: string;
  speaker_label: string;
  participant_id: string;
  created_at: string;
  updated_at: string;
};

type UtteranceRow = {
  id: string;
  discussion_id: string;
  speaker_label: string;
  participant_id: string | null;
  text: string;
  start_ms: number | null;
  end_ms: number | null;
  is_final: 0 | 1;
  source: UtteranceSource;
  created_at: string;
};

type AiTurnRow = {
  id: string;
  discussion_id: string;
  ai_turn_type: AiTurnType;
  codex_thread_id: string | null;
  trigger_start_utterance_id: string | null;
  trigger_end_utterance_id: string | null;
  prompt: string;
  response: string | null;
  status: AiTurnDto["status"];
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
  feedback_rating: AiTurnDto["feedbackRating"] | null;
  feedback_created_at: string | null;
};

type AudioAssetRow = {
  id: string;
  discussion_id: string;
  path: string;
  format: string;
  duration_ms: number | null;
  source: "browser";
  created_at: string;
};

type DiscussionSummaryRow = DiscussionRow & {
  final_utterance_count: number;
  ai_turn_count: number;
  participant_count: number;
  participant_names: string | null;
  audio_asset_count: number;
};

type RespondedAiTurnInput = {
  discussionId: string;
  turnType?: AiTurnType;
  codexThreadId?: string;
  prompt: string;
  response: string;
  triggerStartUtteranceId?: string;
  triggerEndUtteranceId?: string;
};

export class DiscussionRepository {
  constructor(private readonly db: Database) {}

  createDiscussion(input: CreateDiscussionRequest, codexThreadId: string): DiscussionDetailDto {
    const now = new Date().toISOString();
    const discussionId = randomUUID();

    const create = this.db.transaction(() => {
      this.db
        .prepare(
        `INSERT INTO discussions
            (id, title, topic, background, project_path, mode, customer_id, asr_provider, brain_provider, brain_model, codex_thread_id, status, created_at, started_at)
           VALUES
            (@id, @title, @topic, @background, @projectPath, @mode, @customerId, @asrProvider, @brainProvider, @brainModel, @codexThreadId, 'active', @createdAt, @startedAt)`
        )
        .run({
          id: discussionId,
          title: input.title,
          topic: input.topic,
          background: input.background ?? null,
          projectPath: input.projectPath,
          mode: input.mode,
          customerId: input.customerId || null,
          asrProvider: input.asrProvider ?? (input.mode === "mock" ? "mock" : "funasr-realtime"),
          brainProvider: input.brainProvider ?? "mock",
          brainModel: input.brainModel || null,
          codexThreadId,
          createdAt: now,
          startedAt: now
        });

      const insertParticipant = this.db.prepare(
        `INSERT INTO participants (id, discussion_id, display_name, role, sort_order)
         VALUES (@id, @discussionId, @displayName, @role, @sortOrder)`
      );

      input.participants.forEach((participant, index) => {
        insertParticipant.run({
          id: randomUUID(),
          discussionId,
          displayName: participant.displayName,
          role: null,
          sortOrder: index
        });
      });
    });

    create();
    return this.getDiscussionOrThrow(discussionId);
  }

  getDiscussion(id: string): DiscussionDetailDto | null {
    const row = this.db.prepare("SELECT * FROM discussions WHERE id = ?").get(id) as DiscussionRow | undefined;
    if (!row) return null;

    return {
      ...mapDiscussion(row),
      participants: this.listParticipants(id),
      speakerBindings: this.listSpeakerBindings(id),
      utterances: this.listUtterances(id),
      aiTurns: this.listAiTurns(id),
      audioAssets: this.listAudioAssets(id)
    };
  }

  getDiscussionOrThrow(id: string): DiscussionDetailDto {
    const discussion = this.getDiscussion(id);
    if (!discussion) {
      throw new Error(`Discussion not found: ${id}`);
    }
    return discussion;
  }

  listDiscussionSummaries(limit = 20): DiscussionSummaryDto[] {
    const rows = this.db
      .prepare(
        `SELECT
          d.*,
          COALESCE(u.final_utterance_count, 0) AS final_utterance_count,
          COALESCE(a.ai_turn_count, 0) AS ai_turn_count,
          COALESCE(p.participant_count, 0) AS participant_count,
          p.participant_names AS participant_names,
          COALESCE(audio.audio_asset_count, 0) AS audio_asset_count
        FROM discussions d
        LEFT JOIN (
          SELECT discussion_id, COUNT(*) AS final_utterance_count
          FROM utterances
          WHERE is_final = 1
          GROUP BY discussion_id
        ) u ON u.discussion_id = d.id
        LEFT JOIN (
          SELECT discussion_id, COUNT(*) AS ai_turn_count
          FROM ai_turns
          WHERE status IN ('completed', 'truncated')
          GROUP BY discussion_id
        ) a ON a.discussion_id = d.id
        LEFT JOIN (
          SELECT discussion_id, COUNT(*) AS participant_count, GROUP_CONCAT(display_name, '||') AS participant_names
          FROM participants
          GROUP BY discussion_id
        ) p ON p.discussion_id = d.id
        LEFT JOIN (
          SELECT discussion_id, COUNT(*) AS audio_asset_count
          FROM audio_assets
          GROUP BY discussion_id
        ) audio ON audio.discussion_id = d.id
        ORDER BY COALESCE(d.started_at, d.created_at) DESC, d.created_at DESC
        LIMIT ?`
      )
      .all(limit) as DiscussionSummaryRow[];

    return rows.map(mapDiscussionSummary);
  }

  bindSpeaker(discussionId: string, input: BindSpeakerRequest): SpeakerBindingDto {
    const now = new Date().toISOString();
    const existing = this.db
      .prepare("SELECT * FROM speaker_bindings WHERE discussion_id = ? AND speaker_label = ?")
      .get(discussionId, input.speakerLabel) as SpeakerBindingRow | undefined;

    const id = existing?.id ?? randomUUID();
    this.db
      .prepare(
        `INSERT INTO speaker_bindings
          (id, discussion_id, speaker_label, participant_id, created_at, updated_at)
         VALUES
          (@id, @discussionId, @speakerLabel, @participantId, @createdAt, @updatedAt)
         ON CONFLICT(discussion_id, speaker_label)
         DO UPDATE SET participant_id = excluded.participant_id, updated_at = excluded.updated_at`
      )
      .run({
        id,
        discussionId,
        speakerLabel: input.speakerLabel,
        participantId: input.participantId,
        createdAt: existing?.created_at ?? now,
        updatedAt: now
      });

    this.db
      .prepare("UPDATE utterances SET participant_id = ? WHERE discussion_id = ? AND speaker_label = ?")
      .run(input.participantId, discussionId, input.speakerLabel);

    return this.listSpeakerBindings(discussionId).find((binding) => binding.speakerLabel === input.speakerLabel)!;
  }

  addUtterance(input: {
    discussionId: string;
    speakerLabel: string;
    text: string;
    startMs?: number;
    endMs?: number;
    isFinal: boolean;
    source: UtteranceSource;
    rawEvent?: unknown;
  }): UtteranceDto {
    const binding = this.findBinding(input.discussionId, input.speakerLabel);
    const utterance: UtteranceDto = {
      id: randomUUID(),
      discussionId: input.discussionId,
      speakerLabel: input.speakerLabel,
      participantId: binding?.participantId,
      text: input.text,
      startMs: input.startMs,
      endMs: input.endMs,
      isFinal: input.isFinal,
      source: input.source,
      createdAt: new Date().toISOString()
    };

    this.db
      .prepare(
        `INSERT INTO utterances
          (id, discussion_id, speaker_label, participant_id, text, start_ms, end_ms, is_final, source, raw_event_json, created_at)
         VALUES
          (@id, @discussionId, @speakerLabel, @participantId, @text, @startMs, @endMs, @isFinal, @source, @rawEventJson, @createdAt)`
      )
      .run({
        ...utterance,
        participantId: utterance.participantId ?? null,
        startMs: utterance.startMs ?? null,
        endMs: utterance.endMs ?? null,
        isFinal: utterance.isFinal ? 1 : 0,
        rawEventJson: input.rawEvent ? JSON.stringify(input.rawEvent) : null
      });

    return utterance;
  }

  createCompletedAiTurn(input: RespondedAiTurnInput): AiTurnDto {
    return this.createRespondedAiTurn(input, "completed");
  }

  createTruncatedAiTurn(input: RespondedAiTurnInput): AiTurnDto {
    return this.createRespondedAiTurn(input, "truncated");
  }

  private createRespondedAiTurn(input: RespondedAiTurnInput, status: "completed" | "truncated"): AiTurnDto {
    const now = new Date().toISOString();
    const aiTurn: AiTurnDto = {
      id: randomUUID(),
      discussionId: input.discussionId,
      turnType: input.turnType ?? "next_step",
      codexThreadId: input.codexThreadId,
      triggerStartUtteranceId: input.triggerStartUtteranceId,
      triggerEndUtteranceId: input.triggerEndUtteranceId,
      prompt: input.prompt,
      response: input.response,
      status,
      createdAt: now,
      completedAt: now
    };

    this.db
      .prepare(
        `INSERT INTO ai_turns
          (id, discussion_id, ai_turn_type, codex_thread_id, trigger_start_utterance_id, trigger_end_utterance_id, prompt, response, status, created_at, completed_at)
         VALUES
          (@id, @discussionId, @turnType, @codexThreadId, @triggerStartUtteranceId, @triggerEndUtteranceId, @prompt, @response, @status, @createdAt, @completedAt)`
      )
      .run({
        ...aiTurn,
        codexThreadId: aiTurn.codexThreadId ?? null,
        triggerStartUtteranceId: aiTurn.triggerStartUtteranceId ?? null,
        triggerEndUtteranceId: aiTurn.triggerEndUtteranceId ?? null
      });

    return aiTurn;
  }

  createFailedAiTurn(input: {
    discussionId: string;
    turnType?: AiTurnType;
    codexThreadId?: string;
    prompt: string;
    errorMessage: string;
    triggerStartUtteranceId?: string;
    triggerEndUtteranceId?: string;
  }): AiTurnDto {
    const now = new Date().toISOString();
    const aiTurn: AiTurnDto = {
      id: randomUUID(),
      discussionId: input.discussionId,
      turnType: input.turnType ?? "next_step",
      codexThreadId: input.codexThreadId,
      triggerStartUtteranceId: input.triggerStartUtteranceId,
      triggerEndUtteranceId: input.triggerEndUtteranceId,
      prompt: input.prompt,
      status: "failed",
      errorMessage: input.errorMessage,
      createdAt: now,
      completedAt: now
    };

    this.db
      .prepare(
        `INSERT INTO ai_turns
          (id, discussion_id, ai_turn_type, codex_thread_id, trigger_start_utterance_id, trigger_end_utterance_id, prompt, status, error_message, created_at, completed_at)
         VALUES
          (@id, @discussionId, @turnType, @codexThreadId, @triggerStartUtteranceId, @triggerEndUtteranceId, @prompt, @status, @errorMessage, @createdAt, @completedAt)`
      )
      .run({
        ...aiTurn,
        codexThreadId: aiTurn.codexThreadId ?? null,
        triggerStartUtteranceId: aiTurn.triggerStartUtteranceId ?? null,
        triggerEndUtteranceId: aiTurn.triggerEndUtteranceId ?? null
      });

    return aiTurn;
  }

  createAudioAsset(input: {
    discussionId: string;
    path: string;
    format: string;
    durationMs?: number;
    source: "browser";
  }): AudioAssetDto {
    const asset: AudioAssetDto = {
      id: randomUUID(),
      discussionId: input.discussionId,
      path: input.path,
      format: input.format,
      durationMs: input.durationMs,
      source: input.source,
      createdAt: new Date().toISOString()
    };

    this.db
      .prepare(
        `INSERT INTO audio_assets
          (id, discussion_id, path, format, duration_ms, source, created_at)
         VALUES
          (@id, @discussionId, @path, @format, @durationMs, @source, @createdAt)`
      )
      .run({
        ...asset,
        durationMs: asset.durationMs ?? null
      });

    return asset;
  }

  endDiscussion(id: string): DiscussionDetailDto {
    this.db
      .prepare("UPDATE discussions SET status = 'ended', ended_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
    return this.getDiscussionOrThrow(id);
  }

  deleteDiscussion(id: string): boolean {
    const result = this.db.prepare("DELETE FROM discussions WHERE id = ?").run(id);
    return result.changes > 0;
  }

  clearAllDiscussions(): number {
    const result = this.db.prepare("DELETE FROM discussions").run();
    return result.changes;
  }

  deleteAudioAssets(discussionId: string): AudioAssetDto[] {
    const assets = this.listAudioAssets(discussionId);
    this.db.prepare("DELETE FROM audio_assets WHERE discussion_id = ?").run(discussionId);
    return assets;
  }

  markAiTurnFeedback(input: {
    discussionId: string;
    aiTurnId: string;
    rating: NonNullable<AiTurnDto["feedbackRating"]>;
  }): AiTurnDto {
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE ai_turns SET feedback_rating = ?, feedback_created_at = ? WHERE discussion_id = ? AND id = ?")
      .run(input.rating, now, input.discussionId, input.aiTurnId);
    const turn = this.listAiTurns(input.discussionId).find((item) => item.id === input.aiTurnId);
    if (!turn) {
      throw new Error("AI 发言不存在，无法标记反馈。");
    }
    return turn;
  }

  listFinalUtterancesSinceLastAiTurn(discussionId: string): UtteranceDto[] {
    const lastTurn = this.db
      .prepare(
        `SELECT trigger_end_utterance_id, completed_at
         FROM ai_turns
         WHERE discussion_id = ? AND status IN ('completed', 'truncated')
         ORDER BY completed_at DESC
         LIMIT 1`
      )
      .get(discussionId) as { trigger_end_utterance_id: string | null; completed_at: string } | undefined;

    if (lastTurn?.trigger_end_utterance_id) {
      const boundary = this.db
        .prepare("SELECT rowid FROM utterances WHERE id = ?")
        .get(lastTurn.trigger_end_utterance_id) as { rowid: number } | undefined;

      if (boundary) {
        const rows = this.db
          .prepare("SELECT * FROM utterances WHERE discussion_id = ? AND is_final = 1 AND rowid > ? ORDER BY rowid ASC")
          .all(discussionId, boundary.rowid) as UtteranceRow[];
        return rows.map(mapUtterance);
      }
    }

    const rows = lastTurn
      ? (this.db
          .prepare("SELECT * FROM utterances WHERE discussion_id = ? AND is_final = 1 AND created_at > ? ORDER BY created_at ASC")
          .all(discussionId, lastTurn.completed_at) as UtteranceRow[])
      : (this.db
          .prepare("SELECT * FROM utterances WHERE discussion_id = ? AND is_final = 1 ORDER BY created_at ASC")
          .all(discussionId) as UtteranceRow[]);

    return rows.map(mapUtterance);
  }

  private listParticipants(discussionId: string): ParticipantDto[] {
    return (this.db
      .prepare("SELECT * FROM participants WHERE discussion_id = ? ORDER BY sort_order ASC")
      .all(discussionId) as ParticipantRow[]).map(mapParticipant);
  }

  private listSpeakerBindings(discussionId: string): SpeakerBindingDto[] {
    return (this.db
      .prepare("SELECT * FROM speaker_bindings WHERE discussion_id = ? ORDER BY speaker_label ASC")
      .all(discussionId) as SpeakerBindingRow[]).map(mapSpeakerBinding);
  }

  private listUtterances(discussionId: string): UtteranceDto[] {
    return (this.db
      .prepare("SELECT * FROM utterances WHERE discussion_id = ? ORDER BY created_at ASC")
      .all(discussionId) as UtteranceRow[]).map(mapUtterance);
  }

  private listAiTurns(discussionId: string): AiTurnDto[] {
    return (this.db
      .prepare("SELECT * FROM ai_turns WHERE discussion_id = ? ORDER BY created_at ASC")
      .all(discussionId) as AiTurnRow[]).map(mapAiTurn);
  }

  private listAudioAssets(discussionId: string): AudioAssetDto[] {
    return (this.db
      .prepare("SELECT * FROM audio_assets WHERE discussion_id = ? ORDER BY created_at ASC")
      .all(discussionId) as AudioAssetRow[]).map(mapAudioAsset);
  }

  private findBinding(discussionId: string, speakerLabel: string): SpeakerBindingDto | undefined {
    const row = this.db
      .prepare("SELECT * FROM speaker_bindings WHERE discussion_id = ? AND speaker_label = ?")
      .get(discussionId, speakerLabel) as SpeakerBindingRow | undefined;
    return row ? mapSpeakerBinding(row) : undefined;
  }
}

function mapDiscussion(row: DiscussionRow): Omit<DiscussionDto, "participants"> {
  return {
    id: row.id,
    title: row.title,
    topic: row.topic,
    background: row.background ?? undefined,
    projectPath: row.project_path,
    mode: row.mode,
    customerId: row.customer_id ?? undefined,
    asrProvider: row.asr_provider ?? undefined,
    brainProvider: row.brain_provider ?? undefined,
    brainModel: row.brain_model ?? undefined,
    codexThreadId: row.codex_thread_id ?? undefined,
    status: row.status,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    endedAt: row.ended_at ?? undefined
  };
}

function mapDiscussionSummary(row: DiscussionSummaryRow): DiscussionSummaryDto {
  const discussion = mapDiscussion(row);
  return {
    id: discussion.id,
    title: discussion.title,
    topic: discussion.topic,
    status: discussion.status,
    mode: discussion.mode,
    asrProvider: discussion.asrProvider,
    createdAt: discussion.createdAt,
    startedAt: discussion.startedAt,
    endedAt: discussion.endedAt,
    finalUtteranceCount: row.final_utterance_count,
    aiTurnCount: row.ai_turn_count,
    participantCount: row.participant_count,
    participantNames: row.participant_names ? row.participant_names.split("||") : [],
    hasAudioAssets: row.audio_asset_count > 0
  };
}

function mapParticipant(row: ParticipantRow): ParticipantDto {
  return {
    id: row.id,
    discussionId: row.discussion_id,
    displayName: row.display_name,
    role: row.role ?? undefined,
    sortOrder: row.sort_order
  };
}

function mapSpeakerBinding(row: SpeakerBindingRow): SpeakerBindingDto {
  return {
    id: row.id,
    discussionId: row.discussion_id,
    speakerLabel: row.speaker_label,
    participantId: row.participant_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapUtterance(row: UtteranceRow): UtteranceDto {
  return {
    id: row.id,
    discussionId: row.discussion_id,
    speakerLabel: row.speaker_label,
    participantId: row.participant_id ?? undefined,
    text: row.text,
    startMs: row.start_ms ?? undefined,
    endMs: row.end_ms ?? undefined,
    isFinal: row.is_final === 1,
    source: row.source,
    createdAt: row.created_at
  };
}

function mapAiTurn(row: AiTurnRow): AiTurnDto {
  return {
    id: row.id,
    discussionId: row.discussion_id,
    turnType: row.ai_turn_type,
    codexThreadId: row.codex_thread_id ?? undefined,
    triggerStartUtteranceId: row.trigger_start_utterance_id ?? undefined,
    triggerEndUtteranceId: row.trigger_end_utterance_id ?? undefined,
    prompt: row.prompt,
    response: row.response ?? undefined,
    status: row.status,
    errorMessage: row.error_message ?? undefined,
    createdAt: row.created_at,
    completedAt: row.completed_at ?? undefined,
    feedbackRating: row.feedback_rating ?? undefined,
    feedbackCreatedAt: row.feedback_created_at ?? undefined
  };
}

function mapAudioAsset(row: AudioAssetRow): AudioAssetDto {
  return {
    id: row.id,
    discussionId: row.discussion_id,
    path: row.path,
    format: row.format,
    durationMs: row.duration_ms ?? undefined,
    source: row.source,
    createdAt: row.created_at
  };
}
