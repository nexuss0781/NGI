import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * One file, every table. The ledger, the milestones and the mail all live here
 * so a restart loses nothing.
 */
export function openDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  migrate(db);
  return db;
}

export function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS entries (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      at        TEXT NOT NULL,
      agent_id  TEXT NOT NULL,
      round     INTEGER NOT NULL,
      asked     TEXT NOT NULL,
      result    TEXT NOT NULL,
      status    TEXT NOT NULL,
      milestone TEXT,
      phase     TEXT,
      sub_phase TEXT,
      artifacts TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX IF NOT EXISTS entries_round   ON entries (round);
    CREATE INDEX IF NOT EXISTS entries_status  ON entries (status);
    CREATE INDEX IF NOT EXISTS entries_agent   ON entries (agent_id);

    CREATE TABLE IF NOT EXISTS milestones (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      milestone  TEXT NOT NULL,
      phase      TEXT NOT NULL,
      sub_phase  TEXT,
      status     TEXT NOT NULL DEFAULT 'blocked',
      note       TEXT,
      at         TEXT NOT NULL,
      UNIQUE (milestone, phase, sub_phase)
    );

    CREATE TABLE IF NOT EXISTS letters (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      from_id  TEXT NOT NULL,
      to_id    TEXT NOT NULL,
      body     TEXT NOT NULL,
      at       TEXT NOT NULL,
      read     INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS letters_to   ON letters (to_id, read);
    CREATE INDEX IF NOT EXISTS letters_from ON letters (from_id);

    CREATE TABLE IF NOT EXISTS counters (
      name  TEXT PRIMARY KEY,
      value INTEGER NOT NULL
    );
  `);
}
