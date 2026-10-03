import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(fileURLToPath(new URL(".", import.meta.url)), "prompts");

/**
 * Every agent's system prompt is its own markdown file. If it needs to change,
 * you edit the file, not the code.
 */
export function prompt(name: string): string {
  return readFileSync(join(dir, `${name}.md`), "utf8").trim();
}

export function available(): string[] {
  return [
    "agent",
    "inspector",
    "debugger",
    "qa",
    "red-team",
    "intent-documentation",
    "specs-documentation",
    "market-analysis",
    "feature-gathering",
    "feasibility",
    "project-documentation",
    "system-design",
    "database-schema",
    "api-design",
    "ui-ux-design",
    "backend-development",
    "frontend-development",
    "polishments",
    "packaging",
    "documentation",
    "deployment",
  ];
}