import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./schema.ts";

/** Where a piece of work sits in the project. Nothing enforces this, it records it. */
export type Status = "running" | "done" | "partial" | "blocked";

export type Artifact = {
  path: string;
  note?: string | undefined;
};

export type Entry = {
  /** The id of the run that produced this. Links the row to the agent. */
  agentId: string;
  round: number;
  /** What the agent was asked to do, in its own words. */
  asked: string;
  /** What it says it produced. */
  result: string;
  status: Status;
  /** Milestone, phase and sub phase this belongs to, if the agent said. */
  milestone?: string | undefined;
  phase?: string | undefined;
  subPhase?: string | undefined;
  /** Files and documents this run claims to have produced or changed. */
  artifacts: Artifact[];
  at: string;
};

export type NewEntry = Omit<Entry, "at"> & { at?: string };

/**
 * The source of truth. One row per agent run, plus a milestones table so the
 * orchestrator can ask what is done and what is left without rereading prose.
 *
 * Append only. Rows are never edited; a correction is another row.
 */
export class Ledger {
  private readonly db: DatabaseSync;

  /** Takes a path, or a connection already open on the project store. */
  constructor(path: string | DatabaseSync) {
    this.ownDb = typeof path === "string";
    this.db = typeof path === "string" ? openDatabase(path) : path;
  }

  private readonly ownDb: boolean;

  append(entry: NewEntry) {
    this.db
      .prepare(
        `INSERT INTO entries
           (at, agent_id, round, asked, result, status, milestone, phase, sub_phase, artifacts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.at ?? new Date().toISOString(),
        entry.agentId,
        entry.round,
        entry.asked,
        entry.result,
        entry.status,
        entry.milestone ?? null,
        entry.phase ?? null,
        entry.subPhase ?? null,
        JSON.stringify(entry.artifacts),
      );
  }

  read(): Entry[] {
    return (
      this.db
        .prepare(
          `SELECT at, agent_id, round, asked, result, status, milestone, phase, sub_phase, artifacts
           FROM entries ORDER BY id ASC`,
        )
        .all() as Array<Record<string, unknown>>
    ).map(toEntry);
  }

  /** The last N rounds, which is what the orchestrator is given. */
  recent(rounds = 40): Entry[] {
    const all = this.read();
    if (all.length === 0) return [];
    const newest = all[all.length - 1]!.round;
    return all.filter((entry) => entry.round >= newest - rounds + 1);
  }

  /** Everything one agent produced, across rounds. */
  byAgent(agentId: string): Entry[] {
    return this.read().filter((entry) => entry.agentId === agentId);
  }

  /** Every file any run claims to have produced. */
  artifacts(): Artifact[] {
    const seen = new Map<string, Artifact>();
    for (const entry of this.read()) {
      for (const artifact of entry.artifacts) {
        seen.set(artifact.path, artifact);
      }
    }
    return [...seen.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  setMilestone(item: {
    milestone: string;
    phase: string;
    subPhase?: string;
    status?: Status;
    note?: string;
  }) {
    this.db
      .prepare(
        `INSERT INTO milestones (milestone, phase, sub_phase, status, note, at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (milestone, phase, sub_phase)
         DO UPDATE SET status = excluded.status, note = excluded.note, at = excluded.at`,
      )
      .run(
        item.milestone,
        item.phase,
        item.subPhase ?? null,
        item.status ?? "blocked",
        item.note ?? null,
        new Date().toISOString(),
      );
  }

  milestones(): Array<{
    milestone: string;
    phase: string;
    subPhase: string | null;
    status: Status;
    note: string | null;
  }> {
    return (
      this.db
        .prepare("SELECT milestone, phase, sub_phase, status, note FROM milestones ORDER BY id ASC")
        .all() as Array<Record<string, unknown>>
    ).map((row) => ({
      milestone: String(row["milestone"]),
      phase: String(row["phase"]),
      subPhase: row["sub_phase"] === null ? null : String(row["sub_phase"]),
      status: String(row["status"]) as Status,
      note: row["note"] === null ? null : String(row["note"]),
    }));
  }

  /** What is done and what is not, without reading any prose. */
  progress(): { done: number; partial: number; blocked: number; total: number } {
    const counts = { done: 0, partial: 0, blocked: 0, total: 0 };
    for (const entry of this.read()) {
      counts.total += 1;
      if (entry.status === "done") counts.done += 1;
      else if (entry.status === "partial") counts.partial += 1;
      else counts.blocked += 1;
    }
    return counts;
  }

  /**
   * What the orchestrator is handed each round. The state comes first so it
   * knows where it is, then the recent detail.
   */
  text(rounds = 40): string {
    const recent = this.recent(rounds);
    if (recent.length === 0) return "(the project has not started)";

    const milestones = this.milestones();
    const counts = this.progress();

    const head = [
      `State: ${counts.done} done, ${counts.partial} partial, ${counts.blocked} not finished, over ${counts.total} runs.`,
      milestones.length > 0
        ? `\nMilestones:\n${milestones
            .map(
              (item) =>
                `  ${item.milestone} / ${item.phase}${item.subPhase ? ` / ${item.subPhase}` : ""} — ${item.status}${item.note ? `: ${item.note}` : ""}`,
            )
            .join("\n")}`
        : "",
      this.artifacts().length > 0
        ? `\nFiles produced:\n${this.artifacts().map((a) => `  ${a.path}`).join("\n")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");

    const body = recent
      .map(
        (entry) =>
          `${entry.agentId} / round ${entry.round} / ${entry.status}${
            entry.milestone ? ` / ${entry.milestone}${entry.phase ? ` / ${entry.phase}` : ""}` : ""
          }\n   asked: ${truncate(entry.asked, 300)}\n   did: ${truncate(entry.result, 700)}`,
      )
      .join("\n\n");

    return `${head}\n\n${body}`;
  }

  /** Closes the file only if this ledger opened it. */
  close(): void {
    if (this.ownDb) this.db.close();
  }
}

function toEntry(row: Record<string, unknown>): Entry {
  return {
    agentId: String(row["agent_id"]),
    round: Number(row["round"]),
    asked: String(row["asked"]),
    result: String(row["result"]),
    status: String(row["status"]) as Status,
    milestone: row["milestone"] === null ? undefined : String(row["milestone"]),
    phase: row["phase"] === null ? undefined : String(row["phase"]),
    subPhase: row["sub_phase"] === null ? undefined : String(row["sub_phase"]),
    artifacts: JSON.parse(String(row["artifacts"] ?? "[]")) as Artifact[],
    at: String(row["at"]),
  };
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}
