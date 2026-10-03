import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { webTools, webFromEnv, DEPLOYED_WEB_KIT } from "../src/web.js";
import type { Tool } from "../src/tools.js";

const ctx = { from: "agent-1", granted: [] as string[] };

/** A stand-in Web-Kit, so these tests assert behaviour and not a network. */
async function fakeService(
  handler: (body: Record<string, unknown>, auth: string | undefined) => { status?: number; payload: unknown },
): Promise<{
  url: string;
  seen: { auth: string | undefined; path: string; body: Record<string, unknown> }[];
  close: () => Promise<void>;
}> {
  const seen: { auth: string | undefined; path: string; body: Record<string, unknown> }[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      seen.push({ auth: req.headers.authorization, path: req.url ?? "", body });
      const { status = 200, payload } = handler(body, req.headers.authorization);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const searchPayload = {
  query: "aurora",
  results: [
    { rank: 1, title: "Aurora", url: "https://en.wikipedia.org/wiki/Aurora", snippet: "A natural light display.", providers: ["wikipedia"] },
    { rank: 2, title: "Aurora over Iceland", url: "https://news.test/aurora", snippet: "Photographs.", providers: ["hackernews", "wikipedia"] },
  ],
  providers: { wikipedia: { status: "ok", result_count: 1, error: null }, github: { status: "unreachable", result_count: 0, error: "timeout" } },
  warnings: ["github failed: timeout"],
  timing: { duration_ms: 42 },
};

function byName(tools: Tool[], name: string): Tool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool;
}

describe("web tools", () => {
  it("searches, and says which providers agreed", async () => {
    const service = await fakeService(() => ({ payload: searchPayload }));
    try {
      const tools = webTools({ baseUrl: service.url });
      const out = await byName(tools, "web.search").call(JSON.stringify({ query: "aurora", limit: 5 }), ctx);

      expect(out).toContain("Aurora");
      expect(out).toContain("https://en.wikipedia.org/wiki/Aurora");
      expect(out).toContain("via hackernews, wikipedia");
      expect(out).toContain("warnings:");
      expect(out).toContain("github failed");
      expect(service.seen[0]?.path).toBe("/v1/search");
    } finally {
      await service.close();
    }
  });

  it("reports an empty search as empty, and names the providers that failed", async () => {
    const service = await fakeService(() => ({
      payload: { ...searchPayload, results: [], providers: { wikipedia: { status: "empty", result_count: 0, error: null } }, warnings: [] },
    }));
    try {
      const out = await byName(webTools({ baseUrl: service.url }), "web.search").call('query: "aurora"', ctx);
      expect(out).toContain("no results");
      expect(out).not.toContain("https://");
    } finally {
      await service.close();
    }
  });

  it("sends the token, and says so when the server rejects it", async () => {
    const service = await fakeService((_body, auth) =>
      auth
        ? { payload: searchPayload }
        : { status: 401, payload: { error: { code: "E_UNAUTHORIZED", message: "a bearer token is required" } } },
    );
    try {
      const tools = webTools({ baseUrl: service.url, token: "secret-token" });
      const out = await byName(tools, "web.search").call(JSON.stringify({ query: "aurora" }), ctx);
      expect(service.seen[0]?.auth).toBe("Bearer secret-token");
      expect(out).toContain("Aurora");

      const anonymous = await fakeService(() => ({ status: 401, payload: { error: { code: "E_UNAUTHORIZED", message: "nope" } } }));
      try {
        await expect(byName(webTools({ baseUrl: anonymous.url }), "web.search").call("aurora", ctx)).rejects.toThrow(
          /E_UNAUTHORIZED/,
        );
      } finally {
        await anonymous.close();
      }
    } finally {
      await service.close();
    }
  });

  it("fetches a page, defaulting to markdown", async () => {
    const service = await fakeService((body) => ({
      payload: {
        retrieval: { final_url: `${body.url}#top`, status: 200, content_type: "text/html", bytes: 1234 },
        document: {
          metadata: { title: "Aurora", description: null },
          text: "plain",
          markdown: "# Aurora\n\nA natural light display.",
        },
        warnings: [],
      },
    }));
    try {
      const out = await byName(webTools({ baseUrl: service.url }), "web.fetch").call("url: https://en.wikipedia.org/wiki/Aurora", ctx);
      expect(service.seen[0]?.path).toBe("/v1/fetch");
      expect(out).toContain("# Aurora");
      expect(out).toContain("https://en.wikipedia.org/wiki/Aurora#top");
      expect(out).toContain("200");
    } finally {
      await service.close();
    }
  });

  it("asks for text when told to, and truncates a very long page", async () => {
    const long = "x".repeat(40_000);
    const service = await fakeService((body) => ({
      payload: {
        retrieval: { final_url: String(body.url), status: 200, content_type: "text/plain", bytes: long.length },
        document: { metadata: { title: null, description: null }, text: long, markdown: null },
        warnings: [],
      },
    }));
    try {
      const tools = webTools({ baseUrl: service.url });
      const out = await byName(tools, "web.fetch").call(JSON.stringify({ url: "https://big.test/", mode: "text" }), ctx);
      expect(service.seen[0]?.path).toBe("/v1/fetch");
      expect(out).toContain("cut off");
      expect(out.length).toBeLessThan(21_000);
    } finally {
      await service.close();
    }
  });

  it("reads the title from metadata, which is where the service puts it", async () => {
    const service = await fakeService(() => ({
      payload: {
        retrieval: { final_url: "https://a.test/", status: 200, content_type: "text/html", bytes: 10 },
        document: { metadata: { title: "Nested Title", description: null }, text: null, markdown: null },
        warnings: [],
      },
    }));
    try {
      const out = await byName(webTools({ baseUrl: service.url }), "web.fetch").call("url: https://a.test/", ctx);
      expect(out).toContain("Nested Title");
      expect(out).not.toContain("unknown type");
    } finally {
      await service.close();
    }
  });

  it("survives a response with no metadata at all, such as an image", async () => {
    const service = await fakeService(() => ({
      payload: {
        retrieval: { final_url: "https://a.test/favicon.ico", status: 200, content_type: "image/x-icon", bytes: 4430 },
        document: { metadata: null, text: null, markdown: null },
        warnings: [],
      },
    }));
    try {
      const out = await byName(webTools({ baseUrl: service.url }), "web.fetch").call("url: https://a.test/favicon.ico", ctx);
      expect(out).toContain("image/x-icon");
      expect(out).not.toContain("undefined");
      expect(out).not.toContain("null");
    } finally {
      await service.close();
    }
  });

  it("passes a search mode through, and leaves it out when not asked", async () => {
    const service = await fakeService(() => ({ payload: searchPayload }));
    try {
      const tools = webTools({ baseUrl: service.url });
      await byName(tools, "web.search").call(JSON.stringify({ query: "aurora", mode: "fallback" }), ctx);
      expect((service.seen[0]?.body as { mode?: string }).mode).toBe("fallback");

      await byName(tools, "web.search").call(JSON.stringify({ query: "aurora", mode: "nonsense" }), ctx);
      expect((service.seen[1]?.body as { mode?: string }).mode).toBeUndefined();
    } finally {
      await service.close();
    }
  });

  it("needs a query and a url, and says which one", async () => {
    const service = await fakeService(() => ({ payload: searchPayload }));
    try {
      const tools = webTools({ baseUrl: service.url });
      await expect(byName(tools, "web.search").call("{}", ctx)).rejects.toThrow(/query/);
      await expect(byName(tools, "web.fetch").call("{}", ctx)).rejects.toThrow(/url/);
    } finally {
      await service.close();
    }
  });

  it("fails clearly when no server is configured", async () => {
    const tools = webTools({});
    await expect(byName(tools, "web.search").call("aurora", ctx)).rejects.toThrow(/no Web-Kit server/);
  });
});

describe("web.search, with several queries", () => {
  /** Answers per query, so a test can say which angle found what. */
  function byQuery(picks: Record<string, unknown[]>): Parameters<typeof fakeService>[0] {
    return (body) => ({
      payload: {
        ...searchPayload,
        query: String(body.query),
        results: picks[String(body.query)] ?? [],
      },
    });
  }

  it("sends each query separately and keeps one result per turn", async () => {
    const service = await fakeService(
      byQuery({
        aurora: [{ rank: 1, title: "A1", url: "https://a.test/1", snippet: null, providers: ["wikipedia"] }],
        "boreal": [{ rank: 1, title: "B1", url: "https://b.test/1", snippet: null, providers: ["arxiv"] }],
      }),
    );
    try {
      const out = await byName(webTools({ baseUrl: service.url }), "web.search").call(
        JSON.stringify({ queries: ["aurora", "boreal"] }),
        ctx,
      );

      expect(service.seen.map((entry) => entry.body.query).sort()).toEqual(["aurora", "boreal"]);
      // Interleaved, so the second query's only result is not left out.
      expect(out).toContain("A1");
      expect(out).toContain("B1");
    } finally {
      await service.close();
    }
  });

  it("takes a bare string as one whole question, not several words", async () => {
    const service = await fakeService(() => ({ payload: searchPayload }));
    try {
      await byName(webTools({ baseUrl: service.url }), "web.search").call(
        JSON.stringify({ queries: "sqlite vs postgres for embedded storage" }),
        ctx,
      );
      expect(service.seen).toHaveLength(1);
      expect(service.seen[0]?.body.query).toBe("sqlite vs postgres for embedded storage");
    } finally {
      await service.close();
    }
  });

  it("shows the same page once when two queries both find it", async () => {
    const shared = { rank: 1, title: "Shared", url: "https://shared.test/x", snippet: null, providers: ["wikipedia"] };
    const service = await fakeService(
      byQuery({
        aurora: [shared, { ...shared, url: "https://a.test/2", title: "A2" }],
        "boreal": [shared],
      }),
    );
    try {
      const out = await byName(webTools({ baseUrl: service.url }), "web.search").call(
        JSON.stringify({ queries: ["aurora", "boreal"] }),
        ctx,
      );
      expect(out.match(/shared\.test/g)).toHaveLength(1);
    } finally {
      await service.close();
    }
  });

  it("still answers when one query fails, and says which one", async () => {
    const service = await fakeService((body) => {
      if (body.query === "broken") return { status: 500, payload: { error: "upstream" } };
      return { payload: { ...searchPayload, results: [{ rank: 1, title: "Good", url: "https://g.test/1", snippet: null, providers: ["wikipedia"] }] } };
    });
    try {
      const out = await byName(webTools({ baseUrl: service.url }), "web.search").call(
        JSON.stringify({ queries: ["good", "broken"] }),
        ctx,
      );
      expect(out).toContain("Good");
      expect(out).toContain("broken");
    } finally {
      await service.close();
    }
  });

  it("refuses more than four, rather than quietly dropping the rest", async () => {
    const service = await fakeService(() => ({ payload: searchPayload }));
    try {
      await expect(
        byName(webTools({ baseUrl: service.url }), "web.search").call(
          JSON.stringify({ queries: ["a", "b", "c", "d", "e"] }),
          ctx,
        ),
      ).rejects.toThrow(/at most 4/);
    } finally {
      await service.close();
    }
  });

  it("lets the caller choose which providers answer", async () => {
  const service = await fakeService(() => ({ payload: searchPayload }));
  try {
    const tools = webTools({ baseUrl: service.url });
    // The description tells the agent to name the source that fits, so both
    // spellings a model reaches for have to work.
    await byName(tools, "web.search").call(JSON.stringify({ query: "reclaiming space", providers: ["firecrawl"] }), ctx);
    expect(service.seen[0]?.body.providers).toEqual(["firecrawl"]);

    await byName(tools, "web.search").call("query: autovacuum\nproviders: arxiv, github", ctx);
    expect(service.seen[1]?.body.providers).toEqual(["arxiv", "github"]);
  } finally {
    await service.close();
  }
});

it("names the sources in its own description, so the choice is available at call time", () => {
  const description = byName(webTools({}), "web.search").description;
  // Each provider is named in the tool description itself, because a skill file
  // is not in context when the model decides which tool to call.
  for (const id of ["firecrawl", "arxiv", "crossref", "github", "wikipedia", "openlibrary", "hackernews"]) {
    expect(description).toContain(id);
  }
  expect(description).toMatch(/untrusted/i);
});

it("renders results as citations, so a url can be quoted directly", async () => {
    const service = await fakeService(() => ({ payload: searchPayload }));
    try {
      const out = await byName(webTools({ baseUrl: service.url }), "web.search").call("query: aurora", ctx);
      expect(out).toContain("[Aurora](https://en.wikipedia.org/wiki/Aurora)");
      expect(out).toContain("web.fetch");
    } finally {
      await service.close();
    }
  });
});

describe("webFromEnv", () => {
  it("falls back to the deployed server, so a run is never quietly without web access", () => {
    expect(webFromEnv({}).baseUrl).toBe(DEPLOYED_WEB_KIT);
    expect(webFromEnv({}).token).toBeUndefined();
  });

  it("reads either spelling, with the NGI name winning", () => {
    expect(webFromEnv({ WEBKIT_URL: "https://a.test", WEBKIT_API_TOKEN: "k" })).toEqual({
      baseUrl: "https://a.test",
      token: "k",
    });
    expect(webFromEnv({ NGI_WEB_URL: "https://b.test", WEBKIT_URL: "https://a.test" }).baseUrl).toBe("https://b.test");
  });
});
