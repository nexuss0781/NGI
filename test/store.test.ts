import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/schema.js";
import { SqliteMailbox } from "../src/message.js";
import { Ledger } from "../src/ledger.js";
import { Store } from "../src/store.js";
import { Tools } from "../src/tools.js";
import { run } from "../src/run.js";
import { ScriptedModel, text } from "./scripted-model.js";
import type { ModelClient } from "../src/model.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "ngi-store-"));
}

const quiet: ModelClient = { complete: async () => ({ type: "text", content: "" }) };

describe("durable mailbox", () => {
  it("keeps counting ids up across a restart, never handing out the same one", () => {
    const path = join(tmp(), "store.db");

    const first = openDatabase(path);
    const before = new SqliteMailbox(first);
    const a1 = before.open();
    const a2 = before.open();
    first.close();

    const second = openDatabase(path);
    const after = new SqliteMailbox(second);
    const a3 = after.open();
    second.close();

    expect([a1, a2, a3]).toEqual(["agent-1", "agent-2", "agent-3"]);
  });

  it("still has the letters after the process that wrote them is gone", () => {
    const path = join(tmp(), "store.db");

    const first = openDatabase(path);
    const before = new SqliteMailbox(first);
    const agent = before.open();
    const inspector = before.open();
    before.post(inspector, agent, "which migration?");
    first.close();

    const second = openDatabase(path);
    const after = new SqliteMailbox(second);

    expect(after.inbox(agent).map((l) => l.body)).toEqual(["which migration?"]);
    expect(after.sent(inspector).map((l) => l.to)).toEqual([agent]);
    expect(after.all()).toHaveLength(1);
    second.close();
  });

  it("does not hand an already read letter back after a restart", () => {
    const path = join(tmp(), "store.db");

    const first = openDatabase(path);
    const before = new SqliteMailbox(first);
    const agent = before.open();
    before.post("agent-0", agent, "one");
    before.post("agent-0", agent, "two");
    expect(before.take(agent).map((l) => l.body)).toEqual(["one", "two"]);
    first.close();

    const second = openDatabase(path);
    const after = new SqliteMailbox(second);
    expect(after.inbox(agent)).toEqual([]);
    expect(after.take(agent)).toEqual([]);
    expect(after.history(agent)).toHaveLength(2);
    second.close();
  });

  it("delivers a letter sent before a restart into a run started after it", async () => {
    const path = join(tmp(), "store.db");
    const agentId = "agent-1";

    const first = openDatabase(path);
    new SqliteMailbox(first).post("agent-0", agentId, "the spec says nothing about retries");
    first.close();

    const second = openDatabase(path);
    const box = new SqliteMailbox(second);
    const tools = new Tools(box).withMessaging();

    let opening = "";
    const model: ModelClient = {
      complete: async (req) => {
        opening = req.messages.map((m) => m.content).join("\n");
        return text("noted, I will assume three");
      },
    };

    await run({
      model,
      system: "# Agent",
      message: "implement the queue",
      tools: tools.use(["message"]),
      id: agentId,
    });

    expect(opening).toContain("nothing about retries");
    second.close();
  });
});

describe("store", () => {
  it("keeps the ledger and the mail in one file and reopens clean", () => {
    const dir = tmp();
    const path = join(dir, "project.db");

    const first = new Store(path, dir, quiet);
    const id = first.mailbox.open();
    first.mailbox.post("agent-0", id, "hello from before");
    first.ledger.append({
      agentId: id,
      round: 1,
      asked: "do it",
      result: "done\nstatus: done",
      status: "done",
      artifacts: [{ path: "a.ts" }],
    });
    first.close();

    const second = new Store(path, dir, quiet);
    expect(second.ledger.read()).toHaveLength(1);
    expect(second.ledger.progress().done).toBe(1);
    expect(second.mailbox.inbox(id).map((l) => l.body)).toEqual(["hello from before"]);
    // A new run in the reopened store must not collide with the old ids.
    expect(second.mailbox.open()).not.toBe(id);
    second.close();

    rmSync(dir, { recursive: true, force: true });
  });

  it("gives every agent the same tools, and scopes them without breaking the mail", () => {
    const dir = tmp();
    const store = new Store(join(dir, "project.db"), dir, quiet);

    const names = store.tools.names();
    expect(names).toContain("message");
    expect(names).toContain("inspect");
    expect(names).toContain("agent");
    expect(names).toContain("fs.read");
    expect(names).toContain("terminal");

    const scoped = store.forTools(["fs.read", "message"]);
    expect(scoped.names().sort()).toEqual(["fs.read", "message"]);

    const id = scoped.newId();
    scoped.call("message", `to: ${id} body: reachable through a scoped list`);
    expect(store.mailbox.history(id).map((l) => l.body)).toEqual([
      "reachable through a scoped list",
    ]);

    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("the store's tool list", () => {
  it("includes the web tools without being told where Web-Kit is", () => {
    const dir = mkdtempSync(join(tmpdir(), "ngi-webtools-"));
    const store = new Store(join(dir, "project.db"), dir, quiet);
    try {
      const names = store.tools.names();
      expect(names).toContain("web.search");
      expect(names).toContain("web.fetch");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
