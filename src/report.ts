import type { Artifact, Status } from "./ledger.js";

export type Report = {
  status: Status;
  milestone?: string | undefined;
  phase?: string | undefined;
  subPhase?: string | undefined;
  artifacts: Artifact[];
};

/**
 * Bookkeeping only. Nothing is validated and nothing is rejected. An agent that
 * writes no trailer simply gets recorded from what it did say.
 *
 * The trailer the prompts ask for looks like this:
 *
 *   status: done
 *   milestone: 15
 *   phase: 2
 *   sub-phase: 1
 *   files:
 *     - src/db.ts
 */
export function readReport(text: string): Report {
  const field = (name: string): string | undefined => {
    const match = text.match(new RegExp(`^\\s*${name}\\s*:\\s*(.+)$`, "im"));
    return match?.[1]?.trim() || undefined;
  };

  const declared = field("status")?.toLowerCase();
  const status: Status =
    declared === "done" || declared === "partial" || declared === "blocked"
      ? declared
      : /completed\s*:\s*true/i.test(text)
        ? "done"
        : "partial";

  const artifacts: Artifact[] = readFileList(text);

  return {
    status,
    milestone: field("milestone"),
    phase: field("phase"),
    subPhase: field("sub-phase") ?? field("subphase"),
    artifacts,
  };
}

/**
 * Walks the lines after a bare `files:` and takes the bullets under it, stopping
 * at the next `key:` line. A path mentioned anywhere else in the prose is not a
 * file the agent produced, so it is left out.
 */
function readFileList(text: string): Artifact[] {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s*files\s*:\s*$/i.test(line));
  if (start === -1) return [];

  const paths: Artifact[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*[a-z][a-z -]*\s*:/i.test(line)) break;
    const bullet = line.match(/^\s*[-*]\s+(.+?)\s*$/);
    if (bullet?.[1]) paths.push({ path: bullet[1] });
  }
  return paths;
}
