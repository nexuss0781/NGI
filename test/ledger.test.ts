import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/ledger.js";
import { readReport } from "../src/report.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "ngi-ledger-"));
}

describe("report", () => {
  it("reads the trailer an agent is asked to write", () => {
    const report = readReport(`moved the queue into its own table.

status: done
milestone: 15
phase: 2
sub-phase: 1
files:
  - src/db.ts
  - src/migrate/004.sql
completed: true`);

    expect(report.status).toBe("done");
    expect(report.milestone).toBe("15");
    expect(report.phase).toBe("2");
    expect(report.subPhase).toBe("1");
    expect(report.artifacts.map((a) => a.path)).toEqual([
      "src/db.ts",
      "src/migrate/004.sql",
    ]);
  });

  it("reads a blocked report", () => {
    expect(readReport("nothing i can do here\nstatus: blocked\ncompleted: false").status).toBe(
      "blocked",
    );
  });

  it("falls back to completed true when no status was written", () => {
    expect(readReport("all good\ncompleted: true").status).toBe("done");
    expect(readReport("stopped halfway\ncompleted: false").status).toBe("partial");
  });

  it("does not mistake a file listing for one outside the files block", () => {
    const report = readReport(`status: done
files:
  - a.ts
note: read b.ts too`);
    expect(report.artifacts.map((a) => a.path)).toEqual(["a.ts"]);
  });

  it("survives an agent that writes no trailer at all", () => {
    const report = readReport("just prose, nothing else");
    expect(report.status).toBe("partial");
    expect(report.artifacts).toEqual([]);
  });
});

describe("ledger", () => {
  it("records agent id, round and status per run", () => {
    const dir = tmp();
    const ledger = new Ledger(join(dir, "events.db"));

    ledger.append({
      agentId: "agent-2",
      round: 1,
      asked: "design the schema",
      result: "here it is\nstatus: done\nfiles:\n  - src/db.ts",
      status: "done",
      artifacts: [{ path: "src/db.ts" }],
    });

    const [entry] = ledger.read();
    expect(entry?.agentId).toBe("agent-2");
    expect(entry?.round).toBe(1);
    expect(entry?.status).toBe("done");
    expect(entry?.artifacts).toEqual([{ path: "src/db.ts" }]);

    ledger.close();

    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps every artifact the project has ever claimed, without duplicates", () => {
    const dir = tmp();
    const ledger = new Ledger(join(dir, "events.db"));

    ledger.append({ agentId: "a", round: 1, asked: "x", result: "x", status: "done", artifacts: [{ path: "a.ts" }] });
    ledger.append({ agentId: "b", round: 2, asked: "y", result: "y", status: "done", artifacts: [{ path: "a.ts" }, { path: "b.ts" }] });

    expect(ledger.artifacts().map((a) => a.path)).toEqual(["a.ts", "b.ts"]);
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("counts what is done and what is not", () => {
    const dir = tmp();
    const ledger = new Ledger(join(dir, "events.db"));

    ledger.append({ agentId: "a", round: 1, asked: "x", result: "x", status: "done", artifacts: [] });
    ledger.append({ agentId: "b", round: 1, asked: "y", result: "y", status: "partial", artifacts: [] });
    ledger.append({ agentId: "c", round: 2, asked: "z", result: "z", status: "blocked", artifacts: [] });

    expect(ledger.progress()).toEqual({ done: 1, partial: 1, blocked: 1, total: 3 });
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("groups history by agent id across rounds", () => {
    const dir = tmp();
    const ledger = new Ledger(join(dir, "events.db"));

    ledger.append({ agentId: "a", round: 1, asked: "one", result: "r", status: "done", artifacts: [] });
    ledger.append({ agentId: "b", round: 2, asked: "two", result: "r", status: "done", artifacts: [] });
    ledger.append({ agentId: "a", round: 3, asked: "three", result: "r", status: "done", artifacts: [] });

    expect(ledger.byAgent("a").map((e) => e.asked)).toEqual(["one", "three"]);
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("holds milestone, phase and sub phase state", () => {
    const dir = tmp();
    const ledger = new Ledger(join(dir, "events.db"));

    ledger.setMilestone({ milestone: "15", phase: "2", subPhase: "1", status: "blocked", note: "waiting on schema" });
    ledger.setMilestone({ milestone: "15", phase: "2", subPhase: "1", status: "done", note: "migrated" });

    expect(ledger.milestones()).toHaveLength(1);
    expect(ledger.milestones()[0]?.status).toBe("done");
    expect(ledger.milestones()[0]?.note).toBe("migrated");
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("hands the orchestrator the state first, then the detail", () => {
    const dir = tmp();
    const ledger = new Ledger(join(dir, "events.db"));

    expect(ledger.text()).toBe("(the project has not started)");

    ledger.append({
      agentId: "agent-2",
      round: 1,
      asked: "design the schema",
      result: "three tables",
      status: "done",
      milestone: "15",
      phase: "2",
      artifacts: [{ path: "src/db.ts" }],
    });
    ledger.setMilestone({ milestone: "15", phase: "2", subPhase: "1", status: "done" });

    const text = ledger.text();
    expect(text).toContain("1 done");
    expect(text).toContain("15 / 2 / 1 — done");
    expect(text).toContain("src/db.ts");
    expect(text).toContain("agent-2");
    expect(text.indexOf("1 done")).toBeLessThan(text.indexOf("agent-2"));

    ledger.close();

    rmSync(dir, { recursive: true, force: true });
  });

  it("only hands over the recent rounds", () => {
    const dir = tmp();
    const ledger = new Ledger(join(dir, "events.db"));

    for (let round = 1; round <= 10; round += 1) {
      ledger.append({ agentId: `agent-${round}`, round, asked: `ask ${round}`, result: "r", status: "done", artifacts: [] });
    }

    const text = ledger.text(3);
    expect(text).not.toContain("ask 1\n");
    expect(text).toContain("ask 10");
    expect(ledger.recent(3)).toHaveLength(3);

    ledger.close();

    rmSync(dir, { recursive: true, force: true });
  });

  it("survives a reopen", () => {
    const dir = tmp();
    const path = join(dir, "events.db");

    const first = new Ledger(path);
    first.append({ agentId: "a", round: 1, asked: "x", result: "y", status: "done", artifacts: [{ path: "a.ts" }] });
    first.close();

    const second = new Ledger(path);
    expect(second.read()).toHaveLength(1);
    expect(second.artifacts().map((a) => a.path)).toEqual(["a.ts"]);
    second.close();

    rmSync(dir, { recursive: true, force: true });
  });
});
