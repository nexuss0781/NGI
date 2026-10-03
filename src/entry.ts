import { resolve } from "node:path";
import { Store } from "./store.ts";
import { run } from "./run.ts";
import { orchestrate } from "./orchestrator.ts";
import { openAIFromEnv } from "./models/openai.ts";
import { prompt, available } from "./prompts.ts";
import type { ModelClient } from "./model.ts";

export type Options = {
  /** What the user asked for. The one required thing. */
  request: string;
  /** Where the ledger and the file tools both sit. Defaults to the cwd. */
  root?: string;
  /** The ledger file. Defaults to `.ngi/ledger.db` under the root. */
  db?: string;
  model?: ModelClient;
  /**
   * One agent against the tools, instead of a team. This is the mode for "do
   * this one thing", and for testing a prompt change without spending a round of
   * planning first.
   */
  skill?: string;
  /** Only these tools exist. Defaults to all of them. */
  tools?: string[];
  /** How many orchestration rounds before it stops and reports. */
  rounds?: number;
  steps?: number;
  /** Printed as each round and each agent finishes. */
  onEvent?: (event: string) => void;
};

/**
 * What came back, in the shape a caller can print or test without parsing text.
 */
export type Outcome = {
  /** One agent: its answer. A team: every agent's answer. */
  answers: string[];
  /** False when the orchestrator ran out of rounds with work left. */
  settled: boolean;
  rounds: number;
  toolCalls: string[];
};

/**
 * Runs the request and closes everything it opened.
 *
 * This is the entry point the tests never needed and a person always does. The
 * library half is `Store` plus `run`; what was missing was the twenty lines that
 * turn a request into a Store, a model, and an answer -- which is why the
 * package could pass every test and still not do anything when run.
 *
 * Everything is optional except the request, and every option has an environment
 * variable behind it, so the common case is `ngi "..."` with nothing configured
 * beyond the model.
 */
export async function work(options: Options, env: NodeJS.ProcessEnv = process.env): Promise<Outcome> {
  if (!options.request.trim()) throw new Error("a run needs a request");

  const root = resolve(options.root ?? env["NGI_ROOT"] ?? process.cwd());
  const db = resolve(options.db ?? env["NGI_DB"] ?? resolve(root, ".ngi", "ledger.db"));

  // The model is built here rather than required of the caller, because a caller
  // with no model cannot run anything and would rather be told which variable is
  // missing than pass `undefined` and find out three layers down.
  const model = options.model ?? openAIFromEnv(env);
  const store = new Store(db, root, model, {
    ...(env["NGI_FILES_URL"] ? { baseUrl: env["NGI_FILES_URL"] } : {}),
    ...(env["NGI_FILES_TOKEN"] ? { token: env["NGI_FILES_TOKEN"] } : {}),
    ...(env["NGI_WEB_URL"] ? { webUrl: env["NGI_WEB_URL"] } : {}),
    ...(env["NGI_WEB_TOKEN"] ? { webToken: env["NGI_WEB_TOKEN"] } : {}),
  });

  const say = options.onEvent ?? (() => {});
  const scoped = options.tools ? store.forTools(options.tools) : store.tools;

  try {
    if (options.skill) {
      // One agent, no planning. The skill has to be one of ours, because a name
      // we do not have would otherwise become a path someone can walk out of.
      if (!available().includes(options.skill)) {
        throw new Error(`no skill called ${options.skill}; try one of: ${available().join(", ")}`);
      }
      const result = await run({
        model,
        system: prompt(options.skill),
        message: options.request,
        tools: scoped,
        ...(options.steps ? { steps: options.steps } : {}),
      });
      say(`one agent (${options.skill}) finished in ${result.steps} steps`);
      return { answers: [result.text], settled: true, rounds: 1, toolCalls: result.toolCalls };
    }

    const outcome = await orchestrate({
      model,
      ledger: store.ledger,
      tools: scoped,
      request: options.request,
      ...(options.rounds ? { rounds: options.rounds } : {}),
      onRound: (round, plan) => {
        const agents = plan.agents?.map((agent) => agent.skill).join(", ");
        say(`round ${round}${plan.note ? `: ${plan.note}` : ""}${agents ? ` -> ${agents}` : ""}`);
      },
      onAgent: (event, id, skill) => say(`  ${event} ${id} (${skill})`),
    });

    return {
      answers: outcome.results.map((entry) => entry.result),
      // Two ways to stop without finishing: the orchestrator asked a question it
      // could not answer alone, or it hit the round ceiling still handing out
      // work. Both are reported as unsettled, because in both cases the job is
      // open and saying otherwise would be a lie a caller cannot detect.
      settled: outcome.waiting === null && !outcome.exhausted,
      rounds: outcome.rounds,
      toolCalls: outcome.results.flatMap((entry) => entry.report.artifacts.map((artifact) => artifact.path)),
    };
  } finally {
    store.close();
  }
}