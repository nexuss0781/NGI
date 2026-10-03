import { run } from "./run.ts";
import { Ledger } from "./ledger.ts";
import { Tools } from "./tools.ts";
import { prompt } from "./prompts.ts";
import { readReport } from "./report.ts";
import { inspectTool, agentTool } from "./builtin.ts";
import type { ModelClient } from "./model.ts";
import type { Report } from "./report.ts";

export type Assignment = {
  skill: string;
  prompt: string;
  guide?: string;
  tools?: string[];
};

export type Plan = {
  note?: string;
  question?: string;
  wait?: boolean;
  agents?: Assignment[];
};

export type OrchestrateInput = {
  model: ModelClient;
  ledger: Ledger;
  /** Every tool that exists. The orchestrator hands out names from this list. */
  tools: Tools;
  /** The user's original request. */
  request: string;
  rounds?: number;
  onRound?: (round: number, plan: Plan) => void;
  onAgent?: (event: "started" | "finished", id: string, skill: string) => void;
};

export type OrchestrateResult = {
  rounds: number;
  note: string;
  waiting: Plan | null;
  /**
   * True when the round ceiling arrived with work still going. Without this the
   * last round looks exactly like a clean finish -- same `rounds`, same empty
   * `waiting` -- and a caller has no way to tell "done" from "still going".
   */
  exhausted: boolean;
  results: Array<{ skill: string; result: string; id: string; report: Report }>;
};

/**
 * Number the agents, run who and when, take what comes back. The orchestrator
 * decides the sequence; nothing here overrides it.
 */
export async function orchestrate(input: OrchestrateInput): Promise<OrchestrateResult> {
  const rounds = input.rounds ?? 20;
  const results: OrchestrateResult["results"] = [];
  let note = "";
  let waiting: Plan | null = null;

  // The message tool comes first, for everyone. Everything else is optional.
  const shared = input.tools.withMessaging();
  const builtin = shared
    .add(inspectTool({ model: input.model, tools: shared }))
    .add(agentTool({ model: input.model, tools: shared }));

  const orchestratorId = shared.newId();

  for (let round = 1; round <= rounds; round += 1) {
    const decision = await run({
      model: input.model,
      system: prompt("orchestrator"),
      message: [
        `The user asked for:`,
        input.request,
        "",
        `The ledger so far:`,
        input.ledger.text(),
        "",
        `Tools you can hand out: ${builtin.names().join(", ")}`,
        "",
        `Round ${round} of ${rounds}. Reply with your JSON plan.`,
      ].join("\n"),
      tools: builtin.use(["message"]),
      id: orchestratorId,
    });

    const plan = parsePlan(decision.text);
    input.onRound?.(round, plan);

    if (plan.note) note = plan.note;

    if (plan.wait || !plan.agents || plan.agents.length === 0) {
      waiting = plan.wait ? plan : null;
      return { rounds: round, note, waiting, exhausted: false, results };
    }

    // Every agent in a round gets an id when it starts, so any of them can be
    // reached by message.
    const started = plan.agents.map((assignment) => ({
      assignment,
      id: shared.newId(),
    }));

    for (const one of started) {
      input.onAgent?.("started", one.id, one.assignment.skill);
    }

    // Independent assignments go out together.
    const settled = await Promise.all(
      started.map((one) => send(input, shared, one.assignment, one.id)),
    );

    for (const one of settled) {
      const report = readReport(one.result);
      input.ledger.append({
        agentId: one.id,
        round,
        asked: one.guide,
        result: one.result,
        status: report.status,
        milestone: report.milestone,
        phase: report.phase,
        subPhase: report.subPhase,
        artifacts: report.artifacts,
      });
      results.push({ skill: one.skill, result: one.result, id: one.id, report });
      input.onAgent?.("finished", one.id, one.skill);
    }
  }

  // Fell out of the loop, so the ceiling decided this and the orchestrator did not.
  return { rounds, note, waiting, exhausted: true, results };
}

async function send(
  input: OrchestrateInput,
  shared: Tools,
  assignment: Assignment,
  id: string,
): Promise<{ skill: string; guide: string; result: string; id: string }> {
  const guide = [assignment.prompt, assignment.guide].filter(Boolean).join("\n\n");
  const wanted = (assignment.tools ?? []).filter((name) => shared.names().includes(name));
  const tools = shared.use([...new Set([...wanted, "message"])]);

  const result = await run({
    model: input.model,
    system: prompt(assignment.skill),
    message: [
      guide,
      "",
      `You are ${id}. Any specialist you start gets its own id and can message you.`,
      "When the job is done, give back what you produced and where, then end with completed: true.",
    ].join("\n\n"),
    tools,
    id,
  });

  return { skill: assignment.skill, guide, result: result.text, id };
}

/**
 * The orchestrator is expected to reply with JSON only. If it wrapped it in
 * prose, take the JSON out rather than losing the round.
 */
export function parsePlan(text: string): Plan {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1]! : text;

  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return { note: text.trim() };
  }

  try {
    return JSON.parse(candidate.slice(start, end + 1)) as Plan;
  } catch {
    return { note: text.trim() };
  }
}