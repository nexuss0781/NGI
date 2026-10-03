import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { fileTools } from "../src/files.js";
import type { Tool } from "../src/tools.js";

function sandbox(): string {
  return mkdtempSync(join(tmpdir(), "ngi-fs-"));
}

function byName(name: string): Tool {
  const tool = fileTools({ root: sandbox() }).find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool;
}

const ctx = { from: "agent-1", granted: [] as string[] };

describe("file tools", () => {
  it("writes, then reads back exactly what it wrote", async () => {
    const root = sandbox();
    const tools = fileTools({ root });
    const write = tools.find((t) => t.name === "fs.write")!;
    const read = tools.find((t) => t.name === "fs.read")!;

    await write.call(JSON.stringify({ path: "src/app.ts", content: "export const a = 1;\n" }), ctx);
    const back = await read.call(JSON.stringify({ path: "src/app.ts" }), ctx);

    expect(back).toBe("export const a = 1;\n");
    expect(readFileSync(join(root, "src/app.ts"), "utf8")).toBe("export const a = 1;\n");

    rmSync(root, { recursive: true, force: true });
  });

  it("refuses any path that climbs out of the root", async () => {
    const tools = fileTools({ root: sandbox() });
    const write = tools.find((t) => t.name === "fs.write")!;

    await expect(
      write.call(JSON.stringify({ path: "../../etc/passwd", content: "x" }), ctx),
    ).rejects.toThrow("outside the root");
  });

  it("treats a leading slash as the root of the machine, not the host", async () => {
    const root = sandbox();
    const tools = fileTools({ root });
    const write = tools.find((t) => t.name === "fs.write")!;
    const read = tools.find((t) => t.name === "fs.read")!;

    // /etc/passwd names <root>/etc/passwd. The host's own /etc is out of reach
    // and never consulted.
    await write.call(JSON.stringify({ path: "/etc/passwd", content: "rooted" }), ctx);

    expect(await read.call(JSON.stringify({ path: "/etc/passwd" }), ctx)).toBe("rooted");
    expect(readFileSync(join(root, "etc/passwd"), "utf8")).toBe("rooted");

    rmSync(root, { recursive: true, force: true });
  });

  it("reads outside the root as an error rather than throwing", async () => {
    const read = byName("fs.read");
    const out = await read.call(JSON.stringify({ path: "../../../etc/hostname" }), ctx);
    expect(out).toContain("outside the root");
  });

  it("lists a tree and skips node_modules and .git", async () => {
    const root = sandbox();
    const tools = fileTools({ root });
    const write = tools.find((t) => t.name === "fs.write")!;
    const list = tools.find((t) => t.name === "fs.list")!;

    await write.call(JSON.stringify({ path: "src/deep/a.ts", content: "x" }), ctx);
    await write.call(JSON.stringify({ path: "node_modules/pkg/index.js", content: "x" }), ctx);
    await write.call(JSON.stringify({ path: ".git/HEAD", content: "x" }), ctx);

    const out = await list.call(JSON.stringify({ path: ".", depth: 4 }), ctx);
    expect(out).toContain("src/deep/a.ts");
    expect(out).not.toContain("node_modules");
    expect(out).not.toContain(".git");

    rmSync(root, { recursive: true, force: true });
  });

  it("appends instead of replacing", async () => {
    const root = sandbox();
    const tools = fileTools({ root });
    const write = tools.find((t) => t.name === "fs.write")!;
    const append = tools.find((t) => t.name === "fs.append")!;

    await write.call(JSON.stringify({ path: "notes.md", content: "one\n" }), ctx);
    await append.call(JSON.stringify({ path: "notes.md", content: "two\n" }), ctx);

    expect(readFileSync(join(root, "notes.md"), "utf8")).toBe("one\ntwo\n");
    rmSync(root, { recursive: true, force: true });
  });

  it("runs a terminal command in the root and returns its output", async () => {
    const root = sandbox();
    const tools = fileTools({ root });
    const write = tools.find((t) => t.name === "fs.write")!;
    const terminal = tools.find((t) => t.name === "terminal")!;

    await write.call(JSON.stringify({ path: "marker.txt", content: "hello" }), ctx);
    const out = await terminal.call(JSON.stringify({ command: "cat marker.txt" }), ctx);

    expect(out).toContain("hello");
    expect(out).toContain("(exit 0)");
    rmSync(root, { recursive: true, force: true });
  });

  it("reports a failing command instead of throwing", async () => {
    const terminal = byName("terminal");
    const out = await terminal.call(JSON.stringify({ command: "exit 3" }), ctx);
    expect(out).toContain("(exit 3)");
    expect(out).toContain("command failed");
  });

  it("runs shell syntax, and writes where the fs tools read", async () => {
    const root = sandbox();
    const tools = fileTools({ root });
    const terminal = tools.find((t) => t.name === "terminal")!;

    await terminal.call(JSON.stringify({ command: "echo built > out.txt && cat out.txt" }), ctx);
    expect(await tools.find((t) => t.name === "fs.read")!.call(JSON.stringify({ path: "out.txt" }), ctx)).toBe("built\n");

    const piped = await terminal.call(JSON.stringify({ command: "echo one two three | tr ' ' '\\n' | wc" }), ctx);
    expect(piped).toContain("3");
    rmSync(root, { recursive: true, force: true });
  });

  it("stops a command that will not finish", async () => {
    const terminal = byName("terminal");
    const out = await terminal.call(JSON.stringify({ command: "while true; do echo noise; done", timeout: 700 }), ctx);
    expect(out).toContain("stopped after 700ms");
  });

  it("reads a directory as a listing rather than as text", async () => {
    const root = sandbox();
    const tools = fileTools({ root });
    await tools.find((t) => t.name === "fs.write")!.call(
      JSON.stringify({ path: "a/b.txt", content: "x" }),
      ctx,
    );
    const out = await tools.find((t) => t.name === "fs.read")!.call(
      JSON.stringify({ path: "a" }),
      ctx,
    );
    expect(out).toContain("(directory)");
    expect(out).toContain("b.txt");
    rmSync(root, { recursive: true, force: true });
  });

  it("takes plain text arguments as well as JSON", async () => {
    const root = sandbox();
    const tools = fileTools({ root });
    const write = tools.find((t) => t.name === "fs.write")!;
    const read = tools.find((t) => t.name === "fs.read")!;

    await write.call("path: plain.txt content: hello there", ctx);
    expect(await read.call("plain.txt", ctx)).toBe("hello there");
    rmSync(root, { recursive: true, force: true });
  });

  it("caps what it hands back rather than flooding the context", async () => {
    const root = sandbox();
    const tools = fileTools({ root });
    const write = tools.find((t) => t.name === "fs.write")!;
    const read = tools.find((t) => t.name === "fs.read")!;

    await write.call(JSON.stringify({ path: "big.txt", content: "x".repeat(400_000) }), ctx);
    const out = await read.call(JSON.stringify({ path: "big.txt" }), ctx);
    expect(out.length).toBeLessThan(210_000);
    expect(out).toContain("cut off");
    rmSync(root, { recursive: true, force: true });
  });
});

describe("the tools that came with filesystem-kit", () => {
  it("reads a slice of a file by line", async () => {
    const root = sandbox();
    const tools = fileTools({ root });
    await tools.find((t) => t.name === "fs.write")!.call(
      JSON.stringify({ path: "lines.txt", content: "one\ntwo\nthree\nfour" }),
      ctx,
    );
    const read = tools.find((t) => t.name === "fs.read")!;

    expect(await read.call(JSON.stringify({ path: "lines.txt", head: 2 }), ctx)).toBe("one\ntwo");
    expect(await read.call(JSON.stringify({ path: "lines.txt", tail: 1 }), ctx)).toBe("four");
    expect(await read.call(JSON.stringify({ path: "lines.txt", start: 2, end: 3 }), ctx)).toBe("two\nthree");
    rmSync(root, { recursive: true, force: true });
  });

  it("changes existing content in place", async () => {
    const root = sandbox();
    const tools = fileTools({ root });
    await tools.find((t) => t.name === "fs.write")!.call(
      JSON.stringify({ path: "code.ts", content: "const port = 3000;\nconst port = 3000;" }),
      ctx,
    );
    const modify = tools.find((t) => t.name === "fs.modify")!;

    const out = await modify.call(
      JSON.stringify({ path: "code.ts", match: "const port = 3000;", replacement: "const port = 8080;" }),
      ctx,
    );

    expect(out).toContain("replaced 1 occurrence");
    expect(readFileSync(join(root, "code.ts"), "utf8")).toBe("const port = 8080;\nconst port = 3000;");
    rmSync(root, { recursive: true, force: true });
  });

  it("finds files by pattern and content", async () => {
    const root = sandbox();
    const tools = fileTools({ root });
    const write = tools.find((t) => t.name === "fs.write")!;
    await write.call(JSON.stringify({ path: "src/deep/a.ts", content: "alpha" }), ctx);
    await write.call(JSON.stringify({ path: "src/b.md", content: "beta" }), ctx);

    const found = await tools.find((t) => t.name === "fs.glob")!.call(
      JSON.stringify({ pattern: "**/*.ts" }),
      ctx,
    );
    expect(found).toContain("/src/deep/a.ts");
    expect(found).not.toContain("/src/b.md");

    const hits = await tools.find((t) => t.name === "fs.grep")!.call(
      JSON.stringify({ pattern: "beta" }),
      ctx,
    );
    expect(hits).toContain("/src/b.md:1: beta");
    rmSync(root, { recursive: true, force: true });
  });

  it("deletes a file and a tree", async () => {
    const root = sandbox();
    const tools = fileTools({ root });
    const write = tools.find((t) => t.name === "fs.write")!;
    const del = tools.find((t) => t.name === "fs.delete")!;
    await write.call(JSON.stringify({ path: "gone.txt", content: "x" }), ctx);
    await write.call(JSON.stringify({ path: "tree/leaf.txt", content: "x" }), ctx);

    await del.call(JSON.stringify({ path: "gone.txt" }), ctx);
    await del.call(JSON.stringify({ path: "tree", recursive: true }), ctx);

    expect(() => readFileSync(join(root, "gone.txt"))).toThrow();
    expect(() => readFileSync(join(root, "tree/leaf.txt"))).toThrow();
    rmSync(root, { recursive: true, force: true });
  });
});

describe("the same tools on a remote machine", () => {
  it("work over http, terminal included, because the remote machine has a shell too", async () => {
    const root = sandbox();
    process.env.FSK_ROOT = root;
    const { createServer } = await import("filesystem-kit/server");
    const server = createServer().listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      const tools = fileTools({ baseUrl });
      const names = tools.map((t) => t.name);

      expect(names).toContain("fs.write");
      expect(names).toContain("fs.grep");
      expect(names).toContain("terminal");

      const write = tools.find((t) => t.name === "fs.write")!;
      const read = tools.find((t) => t.name === "fs.read")!;

      await write.call(JSON.stringify({ path: "cloud/notes.md", content: "written remotely" }), ctx);
      expect(await read.call(JSON.stringify({ path: "cloud/notes.md" }), ctx)).toBe("written remotely");
      expect(readFileSync(join(root, "cloud/notes.md"), "utf8")).toBe("written remotely");

      // A command on the remote machine writes to the same directory the file
      // tools just wrote to, because both are rooted in the same place.
      const terminal = tools.find((t) => t.name === "terminal")!;
      await terminal.call(JSON.stringify({ command: "echo from-a-shell > cloud/shell.md" }), ctx);
      expect(readFileSync(join(root, "cloud/shell.md"), "utf8")).toBe("from-a-shell\n");
      expect(await read.call(JSON.stringify({ path: "cloud/shell.md" }), ctx)).toBe("from-a-shell\n");

      const failed = await terminal.call(JSON.stringify({ command: "echo boom 1>&2; exit 4" }), ctx);
      expect(failed).toContain("boom");
      expect(failed).toContain("(exit 4)");
      // Spawning three shells while six workers run at once does not fit in the
      // default five seconds, and failing on that says nothing about the tools.
    } finally {
      await new Promise((resolve) => server.close(resolve));
      delete process.env.FSK_ROOT;
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});
