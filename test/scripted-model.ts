import type { ModelClient, Completion } from "../src/model.js";

type ModelRequest = Parameters<ModelClient["complete"]>[0];

type Match = (req: ModelRequest) => boolean;
type Respond = (req: ModelRequest) => Completion | Promise<Completion>;

export class ScriptedModel implements ModelClient {
  readonly requests: ModelRequest[] = [];
  private readonly handlers: Array<{ match: Match; respond: Respond }> = [];

  on(match: Match, respond: Respond) {
    this.handlers.push({ match, respond });
    return this;
  }

  onSystem(needle: string, respond: Respond) {
    return this.on((req) => req.system.includes(needle), respond);
  }

  /** Identifies a role by which tools it was offered. */
  onTool(name: string, respond: Respond) {
    return this.on(
      (req) => req.tools.some((candidate) => candidate.name === name),
      respond,
    );
  }

  /** Catches everything not matched above, so a skill prompt never 404s. */
  onAny(respond: Respond) {
    this.handlers.push({ match: () => true, respond });
    return this;
  }

  async complete(req: ModelRequest): Promise<Completion> {
    this.requests.push(req);
    for (const handler of this.handlers) {
      if (handler.match(req)) return handler.respond(req);
    }
    const heading = req.system.split("\n")[0] ?? "";
    const offered = req.tools.map((candidate) => candidate.name).join(", ");
    throw new Error(
      `no handler for a request whose system prompt starts [${heading.slice(0, 40)}] with tools [${offered}]`,
    );
  }
}

let seq = 0;

export function resetIds() {
  seq = 0;
}

export function text(content: string): Completion {
  return { type: "text", content };
}

export function tool(name: string, input: string): Completion {
  seq += 1;
  return { type: "toolCalls", calls: [{ id: `c${seq}`, name, input }] };
}

export function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}