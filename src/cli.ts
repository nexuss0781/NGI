#!/usr/bin/env node
import { available } from "./prompts.ts";

/**
 * `ngi "add a healthcheck to the server"` and it happens.
 *
 * Flags exist for the things a person cannot type as a sentence -- where the
 * files are, which one agent instead of a team, how long to keep going -- and
 * nothing else. A request is a request, not a config file.
 */
const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
};

if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(
    [
      "usage: ngi <request> [options]",
      "",
      "  --root <dir>      where the files and the ledger sit (default: cwd)",
      "  --db <file>       the ledger file (default: <root>/.ngi/ledger.db)",
      "  --skill <name>    run one agent instead of a team",
      "  --tools a,b       only these tools exist for the run",
      "  --rounds <n>      orchestration rounds before it reports back",
      "  --steps <n>       steps a single --skill run may take",
      "  --list-skills     every skill name that can follow --skill",
      "",
      "model:      NGI_MODEL and NGI_API_KEY",
      "web:        NGI_WEB_URL and NGI_WEB_TOKEN (default: the deployed Web-Kit)",
      "filesystem: NGI_FILES_URL and NGI_FILES_TOKEN (default: this machine)",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

if (args.includes("--list-skills")) {
  process.stdout.write(`${available().join("\n")}\n`);
  process.exit(0);
}

const request = args.filter((arg, at) => !arg.startsWith("--") && !args[at - 1]?.startsWith("--")).join(" ");
const number = (name: string): number | undefined => {
  const raw = flag(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} wants a positive number`);
  return value;
};

// Reading each flag once, into a variable, is not fussiness: with
// `exactOptionalPropertyTypes` a flag read twice is two unrelated reads to the
// type checker, and `{ root: flag("root") }` narrows to nothing.
const root = flag("root");
const db = flag("db");
const skill = flag("skill");
const toolList = flag("tools");
const rounds = number("rounds");
const steps = number("steps");

if (!request.trim()) {
  process.stderr.write("ngi: no request. Try `ngi \"...\"` or `ngi --help`.\n");
  process.exit(2);
}

try {
  // Imported here rather than at the top of the file: the run pulls in the
  // store, the model client and the filesystem package, and `ngi --help` should
  // not have to pay for any of it to print eleven lines.
  const { work } = await import("./entry.ts");

  const outcome = await work({
    request,
    ...(root ? { root } : {}),
    ...(db ? { db } : {}),
    ...(skill ? { skill } : {}),
    ...(toolList ? { tools: toolList.split(",").map((name) => name.trim()) } : {}),
    ...(rounds ? { rounds } : {}),
    ...(steps ? { steps } : {}),
    onEvent: (event) => {
      process.stderr.write(`${event}\n`);
    },
  });

  // Progress went to stderr so a pipe into a file gets only the answer.
  process.stdout.write(`${outcome.answers.join("\n\n---\n\n")}\n`);
  if (!outcome.settled) {
    process.stderr.write("ngi: stopped with work still open; it needs a decision from you.\n");
    process.exit(1);
  }
} catch (error) {
  process.stderr.write(`ngi: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}