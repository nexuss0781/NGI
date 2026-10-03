import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { work } from "../src/entry.js";
import { Ledger } from "../src/ledger.js";
import { ScriptedModel, json, resetIds, text } from "./scripted-model.js";

const run = promisify(execFile);
const cli = new URL("../src/cli.ts", import.meta.url).pathname;

// Starting a process that strips types and loads the whole graph costs more
// than vitest's 5s default. These are still the cheapest tests here: the CLI is
// the thing that was missing, and an entry point that only works when imported
// is not an entry point.
const spawn = { timeout: 60_000 };
const STARTUP_MS = 60_000;

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "ngi-entry-"));
}

async function cliRun(
  args: string[],
  env: NodeJS.ProcessEnv = {},
  options: { timeout?: number } = {},
): Promise<{ code: number; out: string; err: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, ["--experimental-strip-types", cli, ...args], {
      env: { ...process.env, NGI_API_KEY: "", NGI_MODEL: "", ...env },
      ...options,
    });
    return { code: 0, out: stdout, err: stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? 1, out: failed.stdout ?? "", err: failed.stderr ?? "" };
  }
}

describe("work", () => {
  it("is the missing twenty lines: a request in, a Store built, an answer out", async () => {
    resetIds();
    const dir = tmp();
    const db = join(dir, "ledger.db");
    let rounds = 0;

    const model = new ScriptedModel()
      // Hands out one agent, then finds nothing left and stops on round two.
      .onSystem("Orchestrator", (_req) => {
        rounds += 1;
        return text(
          rounds === 1
            ? json({ note: "one agent is enough", agents: [{ skill: "documentation", prompt: "describe it" }] })
            : json({ note: "done" }),
        );
      })
      .onAny(() => text("wrote the doc. completed: true"));

    const events: string[] = [];
    const outcome = await work(
      // Two rounds: the first hands out the agent, the second finds nothing left
      // to do and stops. One round would end on the ceiling, not on the answer.
      { request: "document the thing", db, root: dir, model, rounds: 2, onEvent: (event) => events.push(event) },
      { NGI_API_KEY: "unused", NGI_MODEL: "unused" },
    );

    expect(outcome.answers).toEqual(["wrote the doc. completed: true"]);
    expect(outcome.settled).toBe(true);

    // The ledger is the record of the run, so a real answer has to leave one.
    const ledger = new Ledger(db);
    expect(ledger.read()).toHaveLength(1);
    ledger.close();

    expect(events.some((event) => event.startsWith("round 1"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("puts the ledger under the root when nobody says otherwise", async () => {
    resetIds();
    const dir = tmp();

    const model = new ScriptedModel().onAny(() => text("nothing to report. completed: true"));
    await work({ request: "look around", root: dir, model, rounds: 1, onEvent: () => {} }, {});

    expect(existsSync(join(dir, ".ngi", "ledger.db"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("names the missing model variable instead of failing three layers down", async () => {
    const dir = tmp();
    await expect(
      work({ request: "do something", db: join(dir, "l.db"), root: dir }, { NGI_MODEL: undefined } as NodeJS.ProcessEnv),
    ).rejects.toThrow(/NGI_MODEL/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("will not take a skill name as a path out of the prompts directory", async () => {
    resetIds();
    const dir = tmp();
    const model = new ScriptedModel().onAny(() => text("should never run"));

    await expect(
      work({ request: "x", db: join(dir, "l.db"), root: dir, model, skill: "../../etc/passwd" }, {}),
    ).rejects.toThrow(/no skill called/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs one agent when asked for one, without a planning round", async () => {
    resetIds();
    const dir = tmp();
    const model = new ScriptedModel().onSystem("Inspector", () => text("looked. completed: true"));

    const outcome = await work(
      { request: "what is here", db: join(dir, "l.db"), root: dir, model, skill: "inspector", steps: 2 },
      {},
    );

    expect(outcome.answers).toEqual(["looked. completed: true"]);
    expect(model.requests.every((request) => request.system.length > 0)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not call a stopped run settled", async () => {
    resetIds();
    const dir = tmp();
    // The orchestrator asking to wait is the one case where rounds ran out with
    // the job still open, and reporting that as done would be undetectable
    // downstream.
    const model = new ScriptedModel().onSystem("Orchestrator", () => text(json({ wait: true, question: "which database?" })));

    const outcome = await work({ request: "build it", db: join(dir, "l.db"), root: dir, model, rounds: 1 }, {});

    expect(outcome.settled).toBe(false);
    expect(outcome.answers).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not call a run that hit the round ceiling settled", async () => {
    resetIds();
    const dir = tmp();
    // Every round hands out another agent, so the ceiling decides when this ends.
    // Same answers, same empty `waiting` as a clean finish -- which is why the
    // orchestrator has to say so itself.
    const model = new ScriptedModel()
      .onSystem("Orchestrator", () =>
        text(json({ agents: [{ skill: "documentation", prompt: "write the readme" }] })),
      )
      .onAny(() => text("wrote it. completed: true"));

    const outcome = await work({ request: "document everything", db: join(dir, "l.db"), root: dir, model, rounds: 3 }, {});

    expect(outcome.rounds).toBe(3);
    expect(outcome.answers).toHaveLength(3);
    expect(outcome.settled).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("closes the store even when the run throws", async () => {
    resetIds();
    const dir = tmp();
    const db = join(dir, "l.db");
    const model = new ScriptedModel().onSystem("Orchestrator", () => {
      throw new Error("the model gave up");
    });

    await expect(work({ request: "x", db, root: dir, model, rounds: 1 }, {})).rejects.toThrow(/the model gave up/);

    // An unclosed DatabaseSync holds the file; a second open is the cheapest
    // proof that the first was released.
    const ledger = new Ledger(db);
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("the command", () => {
  it("explains itself without a model or a request", async () => {
    const result = await cliRun(["--help"], {}, spawn);
    expect(result.code).toBe(0);
    expect(result.out).toContain("usage: ngi <request>");
    expect(readFileSync(new URL("../package.json", import.meta.url), "utf8")).toContain('"ngi": "src/cli.ts"');
  }, STARTUP_MS);

  it("refuses an empty request rather than inventing one", async () => {
    const result = await cliRun([], {}, spawn);
    expect(result.code).toBe(2);
    expect(result.err).toContain("no request");
  }, STARTUP_MS);

  it("reports a missing model to the person who typed the command", async () => {
    const result = await cliRun(["build a thing"], { NGI_MODEL: "", NGI_API_KEY: "" }, spawn);
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/NGI_MODEL|NGI_API_KEY/);
  }, STARTUP_MS);

  it("lists the skills a --skill flag could take", async () => {
    const result = await cliRun(["--list-skills"], {}, spawn);
    expect(result.code).toBe(0);
    expect(result.out).toContain("debugger");
  }, STARTUP_MS);
});