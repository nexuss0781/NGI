import type { DatabaseSync } from "node:sqlite";

export type Letter = {
  id: number;
  from: string;
  to: string;
  body: string;
  at: string;
};

/**
 * Every run gets an id when it starts. Agents address each other by that id.
 * An inspector that needs a clarification sends a message to the agent's id
 * and gets the answer back in its own conversation.
 *
 * In memory. Use SqliteMailbox when the correspondence has to outlive the
 * process.
 */
export class Mailbox {
  protected next = 1;
  private readonly byAgent = new Map<string, Letter[]>();
  private readonly outbox: Letter[] = [];

  /** Registers a new run and returns its id. */
  open(prefix = "agent"): string {
    const id = `${prefix}-${this.next}`;
    this.next += 1;
    return id;
  }

  post(from: string, to: string, body: string): Letter {
    const letter: Letter = {
      id: this.next,
      from,
      to,
      body,
      at: new Date().toISOString(),
    };
    this.next += 1;
    this.byAgent.set(to, [...(this.byAgent.get(to) ?? []), letter]);
    this.outbox.push(letter);
    return letter;
  }

  /** Everything waiting for this agent. Reading does not consume. */
  inbox(agent: string): Letter[] {
    return this.byAgent.get(agent) ?? [];
  }

  /** Everything unread, and marks it read. This is what a run absorbs. */
  take(agent: string): Letter[] {
    const letters = this.inbox(agent);
    this.clear(agent);
    return letters;
  }

  /** Every letter ever addressed to this agent, read or not. */
  history(agent: string): Letter[] {
    return this.outbox.filter((letter) => letter.to === agent);
  }

  /** Everything an agent sent, so a run can see what it has asked of others. */
  sent(agent: string): Letter[] {
    return this.outbox.filter((letter) => letter.from === agent);
  }

  /** Marks the agent's unread letters as read, by moving them to seen. */
  clear(agent: string): void {
    this.byAgent.delete(agent);
  }

  all(): Letter[] {
    return [...this.outbox];
  }

  agents(): string[] {
    return [...this.byAgent.keys()];
  }
}

export function formatInbox(letters: Letter[]): string {
  if (letters.length === 0) return "";
  return [
    `You have ${letters.length} message${letters.length === 1 ? "" : "s"} waiting:`,
    ...letters.map(
      (letter) => `  from ${letter.from}: ${letter.body}`,
    ),
  ].join("\n");
}

export function formatLetter(letter: Letter, to: string): string {
  return [
    `Message from ${letter.from}:`,
    letter.body,
    "",
    `Reply with message(to: "${letter.from}", body: "...") if you have an answer.`,
  ].join("\n");
}
/**
 * The same mailbox, on disk. Ids keep counting up across restarts, letters
 * survive, and read state survives too, so a run that has already read a letter
 * does not read it again after a restart.
 */
export class SqliteMailbox extends Mailbox {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    super();
    this.db = db;
    const row = db.prepare("SELECT value FROM counters WHERE name = 'agent'").get() as
      | { value: number }
      | undefined;
    if (row) this.next = Number(row.value) + 1;
  }

  override open(prefix = "agent"): string {
    const id = super.open(prefix);
    this.remember(this.next - 1);
    return id;
  }

  override post(from: string, to: string, body: string): Letter {
    const letter = super.post(from, to, body);
    this.db
      .prepare("INSERT INTO letters (id, from_id, to_id, body, at) VALUES (?, ?, ?, ?, ?)")
      .run(letter.id, letter.from, letter.to, letter.body, letter.at);
    this.remember(this.next - 1);
    return letter;
  }

  override inbox(agent: string): Letter[] {
    return this.rows("WHERE to_id = ? AND read = 0", agent);
  }

  override take(agent: string): Letter[] {
    const letters = this.inbox(agent);
    if (letters.length === 0) return letters;
    const mark = this.db.prepare("UPDATE letters SET read = 1 WHERE id = ?");
    for (const letter of letters) mark.run(letter.id);
    return letters;
  }

  override history(agent: string): Letter[] {
    return this.rows("WHERE to_id = ?", agent);
  }

  override sent(agent: string): Letter[] {
    return this.rows("WHERE from_id = ?", agent);
  }

  override all(): Letter[] {
    return this.rows("", "");
  }

  override agents(): string[] {
    const rows = this.db
      .prepare("SELECT DISTINCT to_id AS id FROM letters WHERE read = 0 ORDER BY to_id")
      .all() as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  private rows(clause: string, arg: string): Letter[] {
    const rows = this.db
      .prepare(`SELECT id, from_id, to_id, body, at FROM letters ${clause} ORDER BY id ASC`)
      .all(...(arg === "" ? [] : [arg])) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: Number(row["id"]),
      from: String(row["from_id"]),
      to: String(row["to_id"]),
      body: String(row["body"]),
      at: String(row["at"]),
    }));
  }

  private remember(highest: number): void {
    this.db
      .prepare("INSERT OR REPLACE INTO counters (name, value) VALUES ('agent', ?)")
      .run(highest);
  }
}
