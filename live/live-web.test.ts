import { test, expect } from "vitest";
import { webTools, webFromEnv } from "../src/web.js";

const ctx = { from: "live", granted: [] as string[] };
const tools = webTools(webFromEnv());

function byName(name: string) {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool;
}

test("live: general search through the deployed service", async () => {
  const out = await byName("web.search").call(
    JSON.stringify({ queries: ["postgres autovacuum reclaiming space", "duckdb parquet local first analytics"], limit: 6 }),
    ctx,
  );
  console.log(out);
  expect(out).toContain("http");
}, 60_000);

test("live: multi-query interleaving keeps both angles", async () => {
  const out = await byName("web.search").call(
    JSON.stringify({ queries: ["site:news.ycombinator.com sqlite", "site:arxiv.org diffusion models"], limit: 10 }),
    ctx,
  );
  console.log(out);
  expect(out.length).toBeGreaterThan(0);
}, 60_000);

test("live: fetch a page and render it if it needs it", async () => {
  const out = await byName("web.fetch").call(JSON.stringify({ url: "https://react.dev/learn", render: "auto" }), ctx);
  console.log(out.slice(0, 600));
  expect(out).toContain("React");
}, 60_000);