import type { Message, ModelClient } from "./model.ts";
import { Tools } from "./tools.ts";
import { formatInbox } from "./message.ts";

export type RunInput = {
  model: ModelClient;
  /** A dedicated markdown file. Never a sentence built in code. */
  system: string;
  /** The guide. One message that tells this run what it is doing. */
  message: string;
  /** Only these tools exist for this run. */
  tools: Tools;
  /** How other agents address this run. Defaults to a fresh id. */
  id?: string;
  steps?: number;
};

export type RunResult = {
  text: string;
  messages: Message[];
  toolCalls: string[];
  steps: number;
  /** The id other agents use to message this run. */
  id: string;
};

/**
 * The one function. Every agent, sub agent and inspector in the system is this
 * function with a different markdown file, a different message and a different
 * tool list. There is no other execution path.
 */
export async function run(input: RunInput): Promise<RunResult> {
  const maxSteps = input.steps ?? 30;
  const id = input.id ?? input.tools.newId();
  const seen = new Set<number>();

  const messages: Message[] = [];
  messages.push({
    role: "user",
    content: [
      input.message,
      `You are ${id}. Other agents reach you at that id with the message tool.`,
    ].join("\n\n"),
  });
  absorb(id, input, messages, seen);

  const toolCalls: string[] = [];
  const granted = input.tools.names();

  for (let step = 1; step <= maxSteps; step += 1) {
    absorb(id, input, messages, seen);

    const reply = await input.model.complete({
      system: input.system,
      messages,
      tools: input.tools.list(),
      stepsLeft: maxSteps - step,
      id,
      inbox: input.tools.inbox(id),
    });

    if (reply.type === "text") {
      messages.push({ role: "assistant", content: reply.content });
      return { text: reply.content, messages, toolCalls, steps: step, id };
    }

    messages.push({
      role: "assistant",
      content: reply.content ?? "",
      toolCalls: reply.calls,
    });

    for (const call of reply.calls) {
      toolCalls.push(call.name);
      let content: string;
      try {
        content = await input.tools.call(call.name, call.input, id, granted);
      } catch (error) {
        content = `not available: ${error instanceof Error ? error.message : call.name}`;
      }
      messages.push({ role: "tool", content, name: call.name, callId: call.id });
    }
  }

  messages.push({ role: "assistant", content: `stopped at ${maxSteps} steps` });
  return {
    text: `stopped at ${maxSteps} steps`,
    messages,
    toolCalls,
    steps: maxSteps,
    id,
  };
}

/**
 * Any letter addressed to this run lands in its conversation as a user message,
 * so a message sent mid run is answered mid run.
 */
function absorb(
  id: string,
  input: RunInput,
  messages: Message[],
  seen: Set<number>,
) {
  for (const letter of input.tools.take(id)) {
    if (seen.has(letter.id)) continue;
    seen.add(letter.id);
    messages.push({
      role: "user",
      content: `Message from ${letter.from}:\n${letter.body}\n\nReply with message(to: "${letter.from}", body: "...") if you have an answer.`,
    });
  }
}

export { formatInbox };
