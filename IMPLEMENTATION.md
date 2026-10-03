# Implementation notes

Not intent. PROJECT.md holds the intent. This file is what the code does, what it
does not do, and where the two disagree.

## What exists

| Piece | Where |
|---|---|
| The one execution loop | `src/run.ts` |
| Orchestrator: plan, run, record | `src/orchestrator.ts` |
| `message`, run ids | `src/message.ts` |
| Tool list as permission | `src/tools.ts` |
| `inspect` and `agent` | `src/builtin.ts` |
| Ledger, milestones, artifacts | `src/ledger.ts` |
| One file, all tables | `src/schema.ts` |
| Persistent project | `src/store.ts` |
| File and terminal tools, over one machine's disk | `src/files.ts`, on `filesystem-kit` |
| Web search and page fetch | `src/web.ts`, on `web-kit` |
| OpenAI compatible model adapter | `src/models/openai.ts` |
| Skill prompts, 22 of them | `src/prompts/` |

`run()` is the only execution path. An orchestrator decision, an agent, a sub
agent and an inspector are all the same function with a different markdown file,
a different message and a different tool list.

## Decisions worth knowing

**A tool list is a permission, and it narrows.** A name not in a run's list does
not exist for it. A sub agent can only be given what its parent holds; what was
refused is reported back to both sides rather than silently dropped.

**Nothing is enforced on the strength of a word.** No verdict header is required,
no completion flag is checked, no regex gate. An agent writes a trailer:

```
status: done
milestone: 15
phase: 2
sub-phase: 1
files:
  - src/db.ts
```

`readReport()` in `src/report.ts` parses it for bookkeeping. A wrong trailer
produces a wrong ledger row, and the inspector is what catches that.

**Messages are durable.** `SqliteMailbox` keeps ids counting up across restarts,
letters survive, and read state survives, so a run does not re-read a letter it
already read. Scoped tool lists share the mailbox, so `use()` cannot break the
correspondence.

**The machine is a setting, not a branch.** `fileTools()` takes either a `root`
or a `baseUrl`, and everything above it is written once. `filesystem-kit` owns
the confinement, the line addressing and the error codes, so `fs.read` behaves the
same on this disk and on a deployed machine, and a `catch` on `ENOENT` works on
both. `terminal` runs through the same backend, so a command starts in the same
root on either machine and what it writes is where the `fs.*` tools read. That is
what makes a remote machine usable for real work: an agent can run a build
against the persisted volume, not just fetch files from it.

One honest limit: a command is a real shell and is not confined by the root the
way the file operations are, and on the deployed machine the userland is small —
`node` and `npm` are there, `grep`, `sed`, `git` and `python3` are not. Searching
and editing go through `fs.grep` and `fs.modify`, which behave identically
everywhere.

**The ledger is state first, prose second.** `Ledger.text()` opens with progress
counts, milestone state and the file list, then the recent runs. The orchestrator
plans from what is true rather than from what an agent claimed.

## Where the code and PROJECT.md disagree

Each of these is a place the document describes something that is not built. Left
in place deliberately, since PROJECT.md is intent.

1. **PROJECT.md:34** says the orchestrator rejects a completion report lacking a
   verdict, checked mechanically. Nothing does this. It was removed once already
   and came back with the doc.
2. **PROJECT.md:33** describes compaction and a context summary as an index. There
   is no compaction and no summary. The ledger replaced the need for it.
3. **PROJECT.md:51** lists browser, vercel, huggingface, todo and github. None
   exist. Built: `fs.read`, `fs.write`, `fs.append`, `fs.modify`, `fs.list`,
   `fs.glob`, `fs.grep`, `fs.delete`, and `terminal`. The fs tools come from
   `filesystem-kit`, so all of them run against a remote machine unchanged.
   `web.search` and `web.fetch` exist too, but they are the two tools that reach
   outside the machine, and they do so through a separate service rather than
   from this process. See below.
4. **PROJECT.md:60** defines an agent as system prompt + agentic skill + tool
   skill + tools. A tool skill has no representation. Tools are names only.
5. **PROJECT.md:9** describes a user leaving a chat to be notified. There is no
   interface at all. `orchestrate()` is a library function.
6. **PROJECT.md:99,107** name `backend-documentation` and the Capacitor and
   Tauri specialists. No prompt files for them.
7. **PROJECT.md:27-28** want multi tier QA and multi stage red team. `qa.md` and
   `red-team.md` are one run each.
8. **PROJECT.md:38-47** categories `build / train / study / compose`. The word
   appears nowhere in the code.
9. **PROJECT.md:62-71** reusable factuals, six domains. Nothing.
10. **PROJECT.md:47,131** the orchestrator creating new agentic skills at
    runtime. Impossible today: `src/prompts.ts` reads a fixed list of files, so a
    skill written mid project is invisible until the process restarts.
11. **PROJECT.md:137** changelog history and checklists on every report. No
    changelog exists.
12. **PROJECT.md:36** narrower grants for sub agents. Now actually true, after
    the widening bug was closed.

## Reaching the web

`web.search` asks several providers at once and ranks what they say together, so
a page more than one of them found comes first. `web.fetch` pulls one page down
as text.

Both go through **Web-Kit**, a separate service, and the separation is the point.
Fetching a URL someone else chose is the one operation in this system where a
mistake has a user's credentials within reach, so the checks that make it safe
-- refusing private and reserved addresses, re-checking every redirect hop,
reading robots.txt, bounding size and time -- live in that service and not in
this process. NGI makes one authenticated request and formats the answer.

Deployed at `https://web-kit.wasmer.app` on the `tadihhuh` account, serving
Wikipedia, Hacker News, arXiv, GitHub, Crossref and Open Library. All six are
free, keyless and official. A seventh, SearXNG, joins the set when an instance
is configured; the public instance network mostly refuses JSON from a
programmatic caller, so it is not relied on. A provider that is slow, rate
limits or is down does not fail the search: it is reported in `warnings` and the
rest of the results stand.

```ts
new Store(path, root, model, {
  webUrl: "https://web-kit.wasmer.app",
  webToken: process.env.WEBKIT_API_TOKEN,
});
```

Without a `webUrl` the tools are still registered and refuse with a clear
message, rather than vanishing from a tool list an agent is reading.

## Next, roughly in order

0. Nothing blocks the rest, but the machine an NGI run works on is currently set
   when the `Store` is built. Reading it from the environment would let one
   process point at a deployed machine without a code change. The same is true
   of `webUrl`: it is passed to the `Store` and nothing reads it for itself.
   Also: NGI is not a git repository, so none of this is under version control
   or recoverable if a file is lost.
1. Runtime skill registration, so item 10 above stops being a dead end. Small
   change to `src/prompts.ts`.
2. The missing four prompts, which are one file each.
3. Reusable factuals, as its own store and a retrieval tool.
4. Multi tier QA, by having `qa.md` fan out through `agent` per tier.
5. An entry point that calls `orchestrate()`. Nothing invokes it today.
