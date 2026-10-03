import { Mailbox, formatInbox } from "./message.ts";
import type { Letter } from "./message.ts";
import type { ToolSpec } from "./model.ts";

/**
 * Who is calling, and with what. A tool that starts another agent may only
 * hand on what the caller already holds, so `granted` is what that agent may
 * pass down.
 */
export type CallContext = {
  /** The id of the run calling this tool. */
  from: string;
  /** Every tool name the calling run holds. */
  granted: string[];
};

export type Tool = {
  name: string;
  description: string;
  /** read tools are what inspectors and read only specialists get. */
  effect: "read" | "write";
  /** JSON Schema for the arguments, passed through to providers that use it. */
  schema?: unknown;
  call: (input: string, ctx: CallContext) => Promise<string> | string;
};

export class Tools {
  private readonly known = new Map<string, Tool>();
  private readonly box: Mailbox;

  constructor(box?: Mailbox) {
    this.box = box ?? new Mailbox();
  }

  add(...tools: Tool[]): this {
    for (const tool of tools) this.known.set(tool.name, tool);
    return this;
  }

  /** Every run in the system, so any two agents can reach each other. */
  get mailbox(): Mailbox {
    return this.box;
  }

  /** Mints the id a run is addressed by. Unique across every scoped copy. */
  newId(): string {
    return this.box.open();
  }

  /**
   * The first tool. Give it to everyone. Lets any run address another run by
   * id; the answer comes back into its own conversation.
   */
  withMessaging(): this {
    return this.add({
      name: "message",
      description:
        "Send a message to another agent by its id. Use it when you need a clarification you cannot get any other way, and answer when one arrives.",
      effect: "read",
      call: (input, ctx) => this.deliver(ctx.from, input),
    });
  }

  private deliver(from: string, input: string): string {
    const args = parseMessage(input);
    const letter = this.box.post(from, args.to, args.body);
    return `delivered to ${letter.to}`;
  }

  /**
   * A tool list is a permission. A name not in the list does not exist for that
   * run, so it is never offered to the model. The mailbox is shared, so a
   * scoped run can still reach every other run.
   */
  use(names: string[]): Tools {
    const scoped = new Tools(this.box);
    for (const name of names) {
      const tool = this.known.get(name);
      if (tool) scoped.add(tool);
    }
    return scoped;
  }

  /** Every read only tool, which is what an inspector or auditor gets. */
  readOnly(): string[] {
    return [...this.known.values()]
      .filter((tool) => tool.effect === "read")
      .map((tool) => tool.name);
  }

  inbox(agent: string): Letter[] {
    return this.box.inbox(agent);
  }

  /** Every letter addressed to this agent, including ones already read. */
  history(agent: string): Letter[] {
    return this.box.history(agent);
  }

  /** Unread letters, and marks them read so a restart will not repeat them. */
  take(agent: string): Letter[] {
    return this.box.take(agent);
  }

  inboxText(agent: string): string {
    return formatInbox(this.box.inbox(agent));
  }

  letters(): Letter[] {
    return this.box.all();
  }

  list(): ToolSpec[] {
    return [...this.known.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      schema: tool.schema,
    }));
  }

  names(): string[] {
    return [...this.known.keys()];
  }

  async call(name: string, input: string, from = "unknown", granted?: string[]): Promise<string> {
    const tool = this.known.get(name);
    if (!tool) throw new Error(`no tool named ${name}`);
    return tool.call(input, { from, granted: granted ?? this.names() });
  }
}

function parseMessage(input: string): { to: string; body: string } {
  const trimmed = input.trim();
  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed) as { to?: string; body?: string };
    if (!parsed.to || !parsed.body) throw new Error("message needs to and body");
    return { to: parsed.to, body: parsed.body };
  }
  const match = trimmed.match(/^to:\s*(\S+)\s+body:\s*([\s\S]+)$/);
  if (!match) throw new Error('message needs "to: <id> body: <text>"');
  return { to: match[1]!, body: match[2]!.trim() };
}