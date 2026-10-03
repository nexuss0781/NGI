import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/run.js";
import { Tools } from "../src/tools.js";
import type { Tool } from "../src/tools.js";
import { Ledger } from "../src/ledger.js";
import { inspectTool, agentTool } from "../src/builtin.js";
import { orchestrate, parsePlan } from "../src/orchestrator.js";
import { available, prompt } from "../src/prompts.js";
import { ScriptedModel, json, resetIds, text, tool } from "./scripted-model.js";

const fsWrite: Tool = {
  name: "fs.write",
  description: "write a file",
  effect: "write",
  call: () => "wrote",
};

const fsRead = { ...fsWrite, name: "fs.read", description: "read a file", effect: "read" as const, call: () => "contents" };
const terminal = { name: "terminal", description: "run a command", effect: "write" as const, call: () => "ok" };

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "ngi-"));
}

describe("run", () => {
  it("is the only execution path: it returns the model's text", async () => {
    const model = new ScriptedModel().onSystem("Agent", () => text("did the work. completed: true"));
    const result = await run({
      model,
      system: prompt("agent"),
      message: "do the thing",
      tools: new Tools(),
    });
    expect(result.text).toContain("completed: true");
    expect(result.id).toMatch(/^agent-/);
  });

  it("only ever offers the tools in the list it was given", async () => {
    const model = new ScriptedModel().onSystem("Agent", (req) => {
      expect(req.tools.map((t) => t.name)).toEqual(["fs.read"]);
      return text("ok");
    });
    await run({
      model,
      system: prompt("agent"),
      message: "look",
      tools: new Tools().add(fsWrite, fsRead, terminal).use(["fs.read"]),
    });
  });

  it("feeds tool output back and lets the model continue", async () => {
    let sawToolResult = false;
    const model = new ScriptedModel().onTool("fs.read", (req) => {
      if (req.messages.some((m) => m.role === "tool")) return text("read it");
      sawToolResult = true;
      return tool("fs.read", "file.txt");
    });

    const result = await run({
      model,
      system: prompt("agent"),
      message: "read it",
      tools: new Tools().add(fsRead),
    });

    expect(sawToolResult).toBe(true);
    expect(result.toolCalls).toEqual(["fs.read"]);
  });

  it("reports a missing tool instead of crashing", async () => {
    const model = new ScriptedModel()
      .onTool("inspect", (req) =>
        req.messages.some((m) => m.role === "tool")
          ? text("done")
          : tool("nope", "x"),
      );
    const result = await run({
      model,
      system: prompt("agent"),
      message: "check",
      tools: new Tools().add({ name: "inspect", description: "check", effect: "read", call: () => "x" }),
    });
    const failed = result.messages.find((m) => m.role === "tool" && m.name === "nope");
    expect(failed?.content).toContain("not available");
  });

  it("stops at the step limit", async () => {
    const model = new ScriptedModel().onTool("fs.read", () => tool("fs.read", "x"));
    const result = await run({
      model,
      system: prompt("agent"),
      message: "loop forever",
      tools: new Tools().add(fsRead),
      steps: 3,
    });
    expect(result.steps).toBe(3);
    expect(result.text).toContain("stopped at 3 steps");
  });
});

describe("message", () => {
  it("gives every run an id and lets another run reach it", async () => {
    const tools = new Tools().withMessaging();
    const agentId = tools.newId();
    const otherId = tools.newId();

    const inspector = new ScriptedModel().onAny((req) =>
      req.messages.some((m) => m.role === "tool")
        ? text("verdict: partial")
        : tool("message", `to: ${agentId} body: which migration?`),
    );

    const result = await run({
      model: inspector,
      system: prompt("inspector"),
      message: "check this",
      tools: tools.use(["message"]),
      id: otherId,
    });

    expect(agentId).not.toBe(otherId);
    expect(tools.inbox(agentId)).toHaveLength(1);
    expect(tools.inbox(agentId)[0]?.body).toBe("which migration?");
    expect(result.text).toContain("partial");
  });

  it("puts waiting messages in the run's first message", async () => {
    const tools = new Tools().withMessaging();
    const id = tools.newId();
    await tools.call("message", `to: ${id} body: the spec says nothing about retries`, "agent-0");

    let opening = "";
    const model = new ScriptedModel().onAny((req) => {
      opening = req.messages.map((m) => m.content).join("\n");
      return text("noted. I will assume three");
    });

    await run({
      model,
      system: prompt("agent"),
      message: "implement the queue",
      tools: tools.use(["message"]),
      id,
    });

    expect(opening).toContain(id);
    expect(opening).toContain("Message from agent-0");
    expect(opening).toContain("nothing about retries");
  });

  it("answers a clarification and the answer reaches the asker", async () => {
    const tools = new Tools().withMessaging();
    const agentId = tools.newId();
    const inspectorIds: string[] = [];

    // The agent finishes phase 15 sub phase 1 and asks for inspection.
    let replied = false;
    const agent = new ScriptedModel().onAny((req) => {
      const said = req.messages.map((m) => m.content).join("\n");
      if (said.includes("verdict: completed")) {
        return text("moved it into 004. completed: true");
      }
      if (!replied && said.includes("which migration?")) {
        replied = true;
        return tool("message", `to: ${inspectorIds[0]} body: 004, added yesterday`);
      }
      return tool("inspect", "phase 15 sub phase 1 done, src/db.ts");
    });

    // The inspector needs a clarification, asks by id, then judges.
    const inspector = new ScriptedModel().onAny((req) => {
      if (!inspectorIds.includes(req.id)) inspectorIds.push(req.id);
      if (req.messages[0]!.content.includes("004, added yesterday")) {
        return text("verdict: completed");
      }
      if (req.messages.some((m) => m.name === "message")) {
        return text("verdict: partial, blocked on your answer");
      }
      return tool("message", `to: ${agentId} body: which migration?`);
    });

    const result = await run({
      model: agent,
      system: prompt("agent"),
      message: "complete phase 15 sub phase 1",
      tools: tools.add(fsWrite, inspectTool({ model: inspector, tools })).use([
        "fs.write",
        "inspect",
        "message",
      ]),
      id: agentId,
    });

    // The inspector's question came back in the tool result, the agent answered
    // by id, and the second inspection carried the answer.
    expect(result.text).toContain("completed: true");
    // Two inspections, two ids: it asked, then it was told and judged again.
    expect(inspectorIds).toHaveLength(2);
    expect(tools.history(inspectorIds[0]!).map((l) => l.body)).toEqual([
      "004, added yesterday",
    ]);
    expect(tools.history(agentId).map((l) => l.body)).toEqual(["which migration?"]);
  });

  it("does not let a sub agent hold more than its parent", async () => {
    const tools = new Tools().withMessaging().add(fsWrite, fsRead, terminal);
    let offered: string[] = [];
    let childOpening = "";

    const child = new ScriptedModel().onAny((req) => {
      offered = req.tools.map((t) => t.name);
      childOpening = req.messages[0]?.content ?? "";
      return text("child done");
    });

    const parent = new ScriptedModel().onAny((req) =>
      req.messages.some((m) => m.role === "tool")
        ? text("parent done")
        : tool("agent", json({ skill: "agent", prompt: "do it", tools: ["fs.write", "terminal"] })),
    );

    const result = await run({
      model: parent,
      system: prompt("agent"),
      message: "delegate",
      tools: tools
        .add(agentTool({ model: child, tools }))
        .use(["message", "agent", "fs.read"]),
    });

    // The parent holds fs.read only, so fs.write and terminal are refused.
    expect(offered).toEqual(["message"]);
    expect(result.text).toBe("parent done");
    const handed = result.messages.find((m) => m.role === "tool" && m.name === "agent");
    expect(handed?.content).toContain("refused");
    expect(childOpening).toContain("does not have either");
  });

  it("keeps the inspector inside the caller grant, and read only", async () => {
    const tools = new Tools().withMessaging().add(fsWrite, fsRead, terminal);
    let offered: string[] = [];

    const inspector = new ScriptedModel().onAny((req) => {
      offered = req.tools.map((t) => t.name);
      return text("verdict: completed");
    });

    const parent = new ScriptedModel().onAny((req) =>
      req.messages.some((m) => m.role === "tool")
        ? text("done. completed: true")
        : tool("inspect", "I wrote it"),
    );

    await run({
      model: parent,
      system: prompt("agent"),
      message: "check",
      tools: tools
        .add(inspectTool({ model: inspector, tools }))
        .use(["message", "inspect", "fs.read"]),
    });

    expect(offered.sort()).toEqual(["fs.read", "message"]);
  });

  it("hands a sub agent only what the parent already had", async () => {
    const tools = new Tools().withMessaging().add(fsWrite, fsRead, terminal);
    let offered: string[] = [];

    const child = new ScriptedModel().onAny((req) => {
      offered = req.tools.map((t) => t.name);
      return text("child done");
    });

    const parent = new ScriptedModel().onAny((req) =>
      req.messages.some((m) => m.role === "tool")
        ? text("parent done")
        : tool("agent", json({ skill: "agent", prompt: "do it", tools: ["fs.read", "terminal"] })),
    );

    await run({
      model: parent,
      system: prompt("agent"),
      message: "delegate",
      tools: tools
        .add(agentTool({ model: child, tools }))
        .use(["message", "agent", "fs.read", "fs.write"]),
    });

    expect(offered.sort()).toEqual(["fs.read", "message"]);
  });
});

describe("orchestrator", () => {
  it("runs who and when it is told, and takes the result", async () => {
    resetIds();
    const dir = tmp();
    const ledger = new Ledger(join(dir, "events.db"));

    const model = new ScriptedModel()
      .onSystem("Orchestrator", () =>
        text(
          json({
            note: "start with the design",
            agents: [{ skill: "system-design", prompt: "design the backend", tools: ["fs.write"] }],
          }),
        ),
      )
      .onAny(() => text("here is the design. completed: true"));

    const outcome = await orchestrate({
      model,
      ledger,
      tools: new Tools().add(fsWrite, fsRead, terminal),
      request: "build a todo app",
      rounds: 1,
    });

    expect(outcome.results).toHaveLength(1);
    expect(outcome.results[0]?.skill).toBe("system-design");
    expect(ledger.read()).toHaveLength(1);
    expect(ledger.read()[0]?.agentId).toMatch(/^agent-/);
    expect(ledger.read()[0]?.round).toBe(1);

    ledger.close();

    rmSync(dir, { recursive: true, force: true });
  });

  it("runs independent assignments together", async () => {
    const dir = tmp();
    const ledger = new Ledger(join(dir, "events.db"));

    const model = new ScriptedModel()
      .onSystem("Orchestrator", () =>
        text(
          json({
            agents: [
              { skill: "api-design", prompt: "design the API" },
              { skill: "database-schema", prompt: "design the schema" },
            ],
          }),
        ),
      )
      .onAny(() => text("done. completed: true"));

    const outcome = await orchestrate({
      model,
      ledger,
      tools: new Tools().add(fsRead),
      request: "build something",
      rounds: 1,
    });

    expect(outcome.results).toHaveLength(2);
    expect(ledger.read().map((entry) => entry.asked.length).every((n) => n > 0)).toBe(true);
    expect(ledger.read()).toHaveLength(2);

    ledger.close();

    rmSync(dir, { recursive: true, force: true });
  });

  it("passes the ledger forward so the next round knows what happened", async () => {
    const dir = tmp();
    const ledger = new Ledger(join(dir, "events.db"));

    let secondRoundMessage = "";
    const model = new ScriptedModel()
      .onSystem("Orchestrator", (req) => {
        if (req.messages[0]!.content.includes("Round 1")) {
          return text(json({ agents: [{ skill: "system-design", prompt: "design it" }] }));
        }
        secondRoundMessage = req.messages[0]!.content;
        return text(json({ wait: true, question: "which database?", note: "need a decision" }));
      })
      .onAny(() => text("schema chosen. completed: true"));

    const outcome = await orchestrate({
      model,
      ledger,
      tools: new Tools().add(fsRead),
      request: "build something",
      rounds: 3,
    });

    expect(secondRoundMessage).toContain("schema chosen");
    expect(outcome.waiting?.question).toBe("which database?");

    ledger.close();

    rmSync(dir, { recursive: true, force: true });
  });

  it("stops and asks the user when the orchestrator says wait", async () => {
    const dir = tmp();
    const ledger = new Ledger(join(dir, "events.db"));
    const model = new ScriptedModel().onSystem("Orchestrator", () =>
      text(json({ wait: true, question: "what should it be called?" })),
    );

    const outcome = await orchestrate({
      model,
      ledger,
      tools: new Tools(),
      request: "build something",
      rounds: 5,
    });

    expect(outcome.rounds).toBe(1);
    expect(outcome.waiting?.question).toBe("what should it be called?");
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("says so when the round ceiling decided, not the orchestrator", async () => {
    resetIds();
    const dir = tmp();
    const ledger = new Ledger(join(dir, "events.db"));

    // Never stops handing out agents, so only the ceiling can end this. Without
    // the flag the result is indistinguishable from a clean finish.
    const model = new ScriptedModel()
      .onSystem("Orchestrator", () => text(json({ agents: [{ skill: "system-design", prompt: "design it" }] })))
      .onAny(() => text("here. completed: true"));

    const outcome = await orchestrate({
      model,
      ledger,
      tools: new Tools(),
      request: "build something",
      rounds: 2,
    });

    expect(outcome.rounds).toBe(2);
    expect(outcome.results).toHaveLength(2);
    expect(outcome.waiting).toBeNull();
    expect(outcome.exhausted).toBe(true);
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("plan parsing", () => {
  it("takes JSON straight from the reply", () => {
    expect(parsePlan('{"agents":[{"skill":"qa","prompt":"x"}]}').agents?.[0]?.skill).toBe("qa");
  });

  it("takes JSON out of a fenced block", () => {
    expect(parsePlan('```json\n{"wait":true}\n```').wait).toBe(true);
  });

  it("takes JSON out of surrounding prose", () => {
    expect(parsePlan('Sure!\n{"wait":true}\nHope that helps').wait).toBe(true);
  });

  it("keeps prose as the note when there is no JSON", () => {
    expect(parsePlan("I need more information first.").note).toContain("more information");
  });
});

describe("prompts", () => {
  it("every advertised skill has a markdown file", () => {
    for (const name of available()) {
      expect(() => prompt(name), name).not.toThrow();
    }
  });

  it("the orchestrator prompt is a real document", () => {
    const text_ = prompt("orchestrator");
    expect(text_.length).toBeGreaterThan(500);
    expect(text_).toContain("who");
  });

  it("the agent prompt tells it to inspect before finishing", () => {
    expect(prompt("agent")).toContain("inspect");
    expect(prompt("agent")).toContain("completed: true");
  });

  it("qa is one report, not a loop", () => {
    expect(prompt("qa")).toContain("one");
    expect(prompt("qa").toLowerCase()).toContain("not a loop");
  });
});