import Database from "better-sqlite3";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

export function openDatabase(databasePath: string): DatabaseInstance {
  mkdirSync(dirname(databasePath), { recursive: true });
  const db = new Database(databasePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db: DatabaseInstance): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS discussions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      topic TEXT NOT NULL,
      background TEXT,
      project_path TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'mock',
      customer_id TEXT,
      asr_provider TEXT NOT NULL DEFAULT 'mock',
      brain_provider TEXT NOT NULL DEFAULT 'mock',
      brain_model TEXT,
      codex_thread_id TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      started_at TEXT,
      ended_at TEXT
    );

    CREATE TABLE IF NOT EXISTS participants (
      id TEXT PRIMARY KEY,
      discussion_id TEXT NOT NULL REFERENCES discussions(id) ON DELETE CASCADE,
      display_name TEXT NOT NULL,
      role TEXT,
      sort_order INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS speaker_bindings (
      id TEXT PRIMARY KEY,
      discussion_id TEXT NOT NULL REFERENCES discussions(id) ON DELETE CASCADE,
      speaker_label TEXT NOT NULL,
      participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (discussion_id, speaker_label)
    );

    CREATE TABLE IF NOT EXISTS utterances (
      id TEXT PRIMARY KEY,
      discussion_id TEXT NOT NULL REFERENCES discussions(id) ON DELETE CASCADE,
      speaker_label TEXT NOT NULL,
      participant_id TEXT,
      text TEXT NOT NULL,
      start_ms INTEGER,
      end_ms INTEGER,
      is_final INTEGER NOT NULL,
      source TEXT NOT NULL,
      raw_event_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ai_turns (
      id TEXT PRIMARY KEY,
      discussion_id TEXT NOT NULL REFERENCES discussions(id) ON DELETE CASCADE,
      ai_turn_type TEXT NOT NULL DEFAULT 'next_step',
      codex_thread_id TEXT,
      trigger_start_utterance_id TEXT,
      trigger_end_utterance_id TEXT,
      prompt TEXT NOT NULL,
      response TEXT,
      status TEXT NOT NULL,
      error_message TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      feedback_rating TEXT,
      feedback_created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS audio_assets (
      id TEXT PRIMARY KEY,
      discussion_id TEXT NOT NULL REFERENCES discussions(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      format TEXT NOT NULL,
      duration_ms INTEGER,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  const discussionColumns = db.prepare("PRAGMA table_info(discussions)").all() as Array<{ name: string }>;
  if (!discussionColumns.some((column) => column.name === "mode")) {
    db.exec("ALTER TABLE discussions ADD COLUMN mode TEXT NOT NULL DEFAULT 'mock'");
  }
  if (!discussionColumns.some((column) => column.name === "customer_id")) {
    db.exec("ALTER TABLE discussions ADD COLUMN customer_id TEXT");
  }
  if (!discussionColumns.some((column) => column.name === "asr_provider")) {
    db.exec("ALTER TABLE discussions ADD COLUMN asr_provider TEXT NOT NULL DEFAULT 'mock'");
  }
  if (!discussionColumns.some((column) => column.name === "brain_provider")) {
    db.exec("ALTER TABLE discussions ADD COLUMN brain_provider TEXT NOT NULL DEFAULT 'mock'");
  }
  if (!discussionColumns.some((column) => column.name === "brain_model")) {
    db.exec("ALTER TABLE discussions ADD COLUMN brain_model TEXT");
  }

  const aiTurnColumns = db.prepare("PRAGMA table_info(ai_turns)").all() as Array<{ name: string }>;
  if (!aiTurnColumns.some((column) => column.name === "ai_turn_type")) {
    db.exec("ALTER TABLE ai_turns ADD COLUMN ai_turn_type TEXT NOT NULL DEFAULT 'next_step'");
  }
  if (!aiTurnColumns.some((column) => column.name === "feedback_rating")) {
    db.exec("ALTER TABLE ai_turns ADD COLUMN feedback_rating TEXT");
  }
  if (!aiTurnColumns.some((column) => column.name === "feedback_created_at")) {
    db.exec("ALTER TABLE ai_turns ADD COLUMN feedback_created_at TEXT");
  }
}
