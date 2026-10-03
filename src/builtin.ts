import { run } from "./run.js";
import type { RunResult } from "./run.js";
import { Tools } from "./tools.js";
import type { CallContext, Tool } from "./tools.js";
import { prompt } from "./prompts.js";

export type BuiltinInput = {
  model: import("./model.js").ModelClient;
  /** Every tool that exists, including file and terminal access. */
  tools: Tools;
  steps?: number;
};

/**
 * `inspect` — the inspector comes out when an agent calls it and nothing else.
 * It is a run with the inspector markdown and the read tools. It can message the
 * agent back, and whatever it asked comes back in the tool result so the agent
 * can answer and inspect again.
 */
export function inspectTool(input: BuiltinInput): Tool {
  /** The inspector it used last, per agent, so it resumes the same thread. */
  const threads = new Map<string, string>();

  return {
    name: "inspect",
    description:
      "Have your work reviewed before you report it done. Pass what you produced and where. Returns verdict: completed, partial, or not_completed, with a report.",
    effect: "read",
    async call(summary: string, ctx: CallContext): Promise<string> {
      // Read only, only what the agent calling it holds, and never itself.
      const usable = input.tools.use(
        input.tools
          .readOnly()
          .filter((name) => name !== "inspect" && ctx.granted.includes(name)),
      );
      const id = input.tools.newId();
      const from = ctx.from;
      const previous = threads.get(from);
      threads.set(from, id);

      const answered = previous
        ? input.tools.history(previous).map((letter) => `${from} replied to you: ${letter.body}`)
        : [];

      const result = await run({
        model: input.model,
        system: prompt("inspector"),
        message: [
          `${from} says this is what it produced:`,
          "",
          summary,
          ...(answered.length > 0 ? ["", "Earlier in this thread:", ...answered] : []),
          "",
          "Look at the actual work, then judge it.",
          `If something is ambiguous and the answer would change your verdict, message ${from} and ask, then say what you still need.`,
        ].join("\n"),
        tools: usable,
        id,
        steps: input.steps ?? 15,
      });

      // History, not inbox: the agent may already have read these.
      const asked = input.tools
        .history(from)
        .filter((letter) => letter.from === id)
        .map((letter) => letter.body);

      return [
        result.text,
        ...(asked.length > 0 ? ["", `${id} asked you:`, ...asked.map((q) => `- ${q}`)] : []),
      ].join("\n");
    },
  };
}

export type AgentArgs = {
  skill: string;
  prompt: string;
  guide?: string;
  tools?: string[];
};

/**
 * `agent` — an agent doing for a sub agent exactly what the orchestrator does
 * for it: choose the skill, hand it a prompt and a tool list, read the result.
 */
export function agentTool(input: BuiltinInput): Tool {
  return {
    name: "agent",
    description:
      "Hand a specific job to another agent. Give the skill, the prompt, and the tools it needs. It gets its own id, and it can message you back if it needs something.",
    effect: "write",
    async call(raw: string, ctx: CallContext): Promise<string> {
      const args = parseArgs(raw);
      const from = ctx.from;
      // A child can never hold more than its parent. Message is always kept so
      // the child can ask for something it was not given.
      const wanted = (args.tools ?? []).filter((name) => ctx.granted.includes(name));
      const dropped = (args.tools ?? []).filter((name) => !ctx.granted.includes(name));

      const id = input.tools.newId();
      const usable = input.tools.use([...wanted, "message"]);

      const result: RunResult = await run({
        model: input.model,
        system: prompt(args.skill),
        message: [
          [args.prompt, args.guide].filter(Boolean).join("\n\n"),
          "",
          `You were started by ${from}. It sees only what you return.`,
          `If you need something you were not given, message ${from} directly and it will answer.`,
          ...(dropped.length > 0
            ? [
                "",
                `You were asked for ${dropped.join(", ")}, which ${from} does not have either, so you cannot have it. Work without it or ask ${from} for a decision.`,
              ]
            : []),
        ].join("\n\n"),
        tools: usable,
        id,
        steps: input.steps ?? 25,
      });

      return [
        result.text,
        "",
        `(you were ${id}; that id is now closed)`,
        ...(dropped.length > 0
          ? ["", `refused, because ${from} does not hold them: ${dropped.join(", ")}`]
          : []),
      ].join("\n");
    },
  };
}

function parseArgs(raw: string): AgentArgs {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed) as AgentArgs;
    } catch {
      throw new Error(`agent arguments were not valid JSON: ${trimmed.slice(0, 80)}`);
    }
  }
  const match = trimmed.match(/^skill:\s*(\S+)\s*\n?([\s\S]*)$/);
  if (!match) {
    throw new Error(`agent needs a skill and a prompt: ${trimmed.slice(0, 80)}`);
  }
  const [skill, ...rest] = match[1]!.split(/\s+/);
  return { skill: skill!, prompt: rest.join(" ") || trimmed };
}