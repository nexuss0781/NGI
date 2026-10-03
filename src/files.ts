import { createFilesystem } from "filesystem-kit";
import type { Entry, Filesystem, LineRange } from "filesystem-kit";
import type { Tool } from "./tools.ts";

const MAX_OUTPUT = 20_000;
const MAX_WRITE = 2_000_000;
const DEFAULT_TIMEOUT = 120_000;
/** A remote machine answers in ~200ms, so a deep walk is worth bounding. */
const DEFAULT_DEPTH = 2;

export type FileToolOptions = {
  /** Root of the local machine. Ignored when `baseUrl` is set. */
  root?: string | undefined;
  /** A FileSystem Kit server, to work on a remote machine instead. */
  baseUrl?: string | undefined;
  /** Bearer token, when the server requires one. */
  token?: string | undefined;
  /** Cap on terminal runtime and on a single remote request, milliseconds. */
  timeout?: number | undefined;
};

/**
 * The real tools, over one machine's disk.
 *
 * `filesystem-kit` decides where the root is and refuses anything that leaves
 * it, so every tool here inherits the same confinement and the same meaning for
 * a line number. Giving `baseUrl` instead of `root` puts the same tools on a
 * remote machine without a line of change below.
 */
export function fileTools(options: FileToolOptions): Tool[] {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
  const fsx = createFilesystem({
    cwd: options.baseUrl ? undefined : (options.root ?? process.cwd()),
    baseUrl: options.baseUrl,
    token: options.token,
  });

  const tools: Tool[] = [
    {
      name: "fs.read",
      description:
        "Read a file as it is on the machine. { path }, plus at most one of { head }, { tail } or { start, end } for a slice by line. A directory reads as a listing.",
      effect: "read",
      async call(input) {
        const args = parse(input);
        const target = args.path ?? "";
        try {
          const text = await fsx.read(target, slice(args));
          return cap(text, text.length);
        } catch (error) {
          if (isDirectory(error)) {
            return `(directory)\n${await listing(fsx, target, args.depth ?? DEFAULT_DEPTH)}`;
          }
          if (args.head == null && args.tail == null && args.start == null) {
            return `could not read ${target}: ${reason(error)}`;
          }
          throw error;
        }
      },
    },
    {
      name: "fs.write",
      description:
        "Write a file, creating it and any directories above it. { path, content }. Overwrites without asking.",
      effect: "write",
      async call(input) {
        const args = parse(input);
        if (!args.path) throw new Error("fs.write needs a path");
        const content = args.content ?? "";
        if (content.length > MAX_WRITE) {
          throw new Error(`content is ${content.length} characters, the limit is ${MAX_WRITE}`);
        }
        const written = await fsx.write(args.path, content);
        return `wrote ${written.bytes} bytes to ${args.path}`;
      },
    },
    {
      name: "fs.append",
      description: "Add to the end of a file, creating it if needed. { path, content }.",
      effect: "write",
      async call(input) {
        const args = parse(input);
        if (!args.path) throw new Error("fs.append needs a path");
        const written = await fsx.write(args.path, args.content ?? "", { append: true });
        return `appended ${written.bytes} bytes to ${args.path}`;
      },
    },
    {
      name: "fs.modify",
      description:
        "Change existing content without rewriting the file. { path, match, replacement } to replace one occurrence, { path, occurrence } to pick which, or { path, rewrite } to replace the whole file.",
      effect: "write",
      async call(input) {
        const args = parse(input);
        if (!args.path) throw new Error("fs.modify needs a path");
        const result = await fsx.modify(args.path, {
          match: args.match,
          replacement: args.replacement,
          occurrence: args.occurrence,
          rewrite: args.rewrite,
        });
        return `replaced ${result.replacements} occurrence in ${args.path}`;
      },
    },
    {
      name: "fs.list",
      description:
        "List what is in a directory. { path }, optional { depth } to walk deeper and { all } to include dotfiles. Skips node_modules and .git.",
      effect: "read",
      async call(input) {
        const args = parse(input);
        return listing(fsx, args.path ?? ".", args.depth ?? DEFAULT_DEPTH, args.all);
      },
    },
    {
      name: "fs.glob",
      description:
        "Find files by pattern. { pattern, path }. Use ** to span folders, as in **/*.ts. Returns matching paths.",
      effect: "read",
      async call(input) {
        const args = parse(input);
        if (!args.pattern) throw new Error("fs.glob needs a pattern");
        const found = await fsx.glob(args.pattern, { path: args.path ?? ".", all: args.all });
        return found.length === 0 ? "(no matches)" : cap(found.join("\n"), found.length);
      },
    },
    {
      name: "fs.grep",
      description:
        "Search file contents for a pattern. { pattern, path }, optional { ignoreCase }. Returns the path, line number and text of each match.",
      effect: "read",
      async call(input) {
        const args = parse(input);
        if (!args.pattern) throw new Error("fs.grep needs a pattern");
        const matches = await fsx.grep(args.pattern, {
          path: args.path ?? ".",
          ignoreCase: args.ignoreCase,
          all: args.all,
        });
        if (matches.length === 0) return "(no matches)";
        const body = matches.map((match) => `${match.path}:${match.line}: ${match.text}`).join("\n");
        return cap(body, matches.length);
      },
    },
    {
      name: "fs.delete",
      description:
        "Delete a file, or a directory with { recursive: true }. This is not reversible. List the directory first.",
      effect: "write",
      async call(input) {
        const args = parse(input);
        if (!args.path) throw new Error("fs.delete needs a path");
        await fsx.remove(args.path, { recursive: args.recursive, force: args.force });
        return `deleted ${args.path}`;
      },
    },
  ];

  tools.push({
    name: "terminal",
    description:
      "Run one shell command on the machine these tools are pointed at, starting in the project root. { command, timeout }. Use it for git, package managers, tests and build steps. Shell syntax works normally: pipes, && and > redirection all behave as typed. It writes to the same disk the fs.* tools read.",
    effect: "write",
    async call(input) {
      const args = parse(input);
      const command = args.command ?? args.path ?? "";
      if (!command.trim()) throw new Error("terminal needs a command");
      const result = await fsx.exec(command, { timeoutMs: args.timeout ?? timeout, env: { CI: "1" } });
      const note = result.timedOut
        ? `(stopped after ${args.timeout ?? timeout}ms)`
        : result.truncated
          ? `(output cut off at ${MAX_OUTPUT} characters)`
          : `(exit ${result.code})`;
      return format(result.stdout, result.stderr, result.code !== 0, note);
    },
  });

  return tools;
}

/** At most one selector, matching what the underlying machine accepts. */
function slice(args: Args): { head?: number | undefined; tail?: number | undefined; range?: LineRange | undefined } | undefined {
  if (args.start == null && args.head == null && args.tail == null) return undefined;
  if (args.start != null) return { range: { start: args.start, end: args.end } };
  if (args.head != null) return { head: args.head };
  return { tail: args.tail };
}

async function listing(fsx: Filesystem, dir: string, depth = DEFAULT_DEPTH, all?: boolean): Promise<string> {
  const found: string[] = [];
  const walk = async (current: string, level: number): Promise<void> => {
    if (level > depth) return;
    let entries: Entry[];
    try {
      entries = await fsx.list(current, { all });
    } catch (error) {
      found.push(`(unreadable ${current}: ${reason(error)})`);
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      found.push(entry.path);
      if (entry.type === "directory") await walk(entry.path, level + 1);
    }
  };
  await walk(dir, 1);
  return found.length === 0 ? "(empty)" : cap(found.join("\n"), found.length);
}

function isDirectory(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "EISDIR" || code === "ERR_FS_EISDIR" || code === "EINVAL";
}

function format(stdout: string, stderr: string, failed = false, note = "(exit 0)"): string {
  const parts = [stdout.trim(), stderr.trim()].filter(Boolean);
  const body = cap(parts.join("\n"), bodyLength(stdout, stderr));
  const trailer = failed ? `${note}, command failed` : note;
  return body ? `${body}\n${trailer}` : `(no output)\n${trailer}`;
}

function bodyLength(...parts: string[]): number {
  return parts.reduce((total, part) => total + part.length, 0);
}

function cap(text: string, total: number): string {
  if (text.length <= MAX_OUTPUT) return text;
  return `${text.slice(0, MAX_OUTPUT)}\n... cut off, ${total} characters in total`;
}


function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type Args = {
  path?: string;
  content?: string;
  command?: string;
  pattern?: string;
  match?: string;
  replacement?: string;
  rewrite?: string;
  occurrence?: number;
  head?: number;
  tail?: number;
  start?: number;
  end?: number;
  depth?: number;
  timeout?: number;
  all?: boolean;
  ignoreCase?: boolean;
  recursive?: boolean;
  force?: boolean;
};

const NUMERIC = new Set(["occurrence", "head", "tail", "start", "end", "depth", "timeout"]);
const BOOLEAN = new Set(["all", "ignoreCase", "recursive", "force"]);
const TEXT = new Set(["path", "content", "command", "pattern", "match", "replacement", "rewrite"]);

/** Accepts JSON, or `path: x content: y`, or a bare path. */
function parse(input: string): Args {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("no arguments");
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed) as Args;
    } catch {
      throw new Error(`arguments were not valid JSON: ${trimmed.slice(0, 80)}`);
    }
  }
  if (!/[a-z]+:/i.test(trimmed)) return { path: trimmed };
  const args: Args = {};
  const re = /([a-z]+):\s*([\s\S]*?)(?=\s+[a-z]+:\s|$)/gi;
  for (const match of trimmed.matchAll(re)) {
    const key = match[1]!.toLowerCase();
    const value = match[2]!.trim();
    if (NUMERIC.has(key)) args[key as keyof Args] = Number(value) as never;
    else if (BOOLEAN.has(key)) args[key as keyof Args] = (value === "true" || value === "1") as never;
    else if (TEXT.has(key)) args[key as keyof Args] = value as never;
  }
  return args;
}
