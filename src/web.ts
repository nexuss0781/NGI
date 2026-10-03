import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { lookup } from "node:dns/promises";
import type { Tool } from "./tools.js";

/**
 * The two tools that let an agent read the outside world: ask several search
 * providers at once, then pull a page down as text.
 *
 * Web-Kit is a separate service because it is the part that has to be careful.
 * Its own fetch path refuses private addresses, follows redirects one checked
 * hop at a time, reads robots.txt and bounds every response, and none of that
 * belongs in this process, where a mistake would have a user's credentials
 * within reach.
 */

const MAX_OUTPUT = 20_000;
const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_RESULTS = 8;

/**
 * The deployed instance.
 *
 * This is a fallback rather than a requirement, and the reason is a failure
 * mode worth naming: with no server configured every `web.search` call raises
 * "no Web-Kit server is configured for this run", which reads to an agent as a
 * broken tool rather than a missing one, and to a person as a run that simply
 * has no search. Point it somewhere else with WEBKIT_URL when there is
 * somewhere else.
 */
export const DEPLOYED_WEB_KIT = "https://web-kit.wasmer.app";

/**
 * Reads the environment only, in the same shape as `openAIFromEnv`. The NGI
 * prefix wins, so one process can point at its own instance, and the Web-Kit
 * names are accepted because they are what the service's own documentation
 * uses.
 */
export function webFromEnv(env: NodeJS.ProcessEnv = process.env): WebToolOptions {
  return {
    baseUrl: env["NGI_WEB_URL"] ?? env["WEBKIT_URL"] ?? DEPLOYED_WEB_KIT,
    token: env["NGI_WEB_TOKEN"] ?? env["WEBKIT_API_TOKEN"],
  };
}

export type WebToolOptions = {
  /** A Web-Kit server. */
  baseUrl?: string | undefined;
  /** Bearer token, when the server requires one. */
  token?: string | undefined;
  /** Cap on one request, milliseconds. */
  timeout?: number | undefined;
};

/** One HTTP answer, kept as a status and a body because that is all that is read. */
type Reply = { status: number; body: string };

/** A response this module will not read past, whatever the service sends. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/**
 * Resolved addresses, remembered per host. A tool call loop would otherwise ask
 * DNS on every request, and the answer cannot change usefully within a run.
 */
const resolved = new Map<string, Promise<4 | 6>>();

async function familyFor(hostname: string): Promise<4 | 6> {
  const cached = resolved.get(hostname);
  if (cached) return cached;

  const pending = lookup(hostname, { all: true }).then((answers) => {
    if (answers.length === 0) throw new Error(`could not resolve ${hostname}`);
    // IPv4 when the host has it, and otherwise whatever it does have, which is
    // how a genuinely IPv6-only host still works.
    return (answers.find((answer) => answer.family === 4) ?? answers[0]!).family as 4 | 6;
  });

  resolved.set(hostname, pending);
  // A name that did not resolve may resolve next time; do not cache the miss.
  pending.catch(() => resolved.delete(hostname));
  return pending;
}

/** The parts of the service's contract this module depends on. */
type SearchResult = {
  rank: number;
  title: string;
  url: string;
  snippet: string | null;
  providers: string[];
};

type SearchResponse = {
  query: string;
  results: SearchResult[];
  providers: Record<string, { status: string; result_count: number; error: string | null }>;
  warnings: string[];
  timing: { duration_ms: number };
};

/**
 * The title lives under `metadata`, not at the top of `document`, so it is
 * worth reading it from where the service actually puts it: a client written
 * against a guess returns "unknown type" for every page it fetches.
 */
type FetchResponse = {
  retrieval: { final_url: string; status: number; content_type: string | null; bytes: number };
  document: {
    /** Null when the response was not something readable, such as an image. */
    metadata: { title: string | null; description: string | null } | null;
    text: string | null;
    markdown: string | null;
  };
  warnings: string[];
};

export function webTools(options: WebToolOptions): Tool[] {
  const baseUrl = (options.baseUrl ?? "").replace(/\/+$/, "");
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;

  /**
   * One call to the service, with the failures turned into readable text.
   *
   * This does not use global `fetch`, for one measured reason: a host with both
   * an A and an AAAA record is asked for the AAAA one, and if this machine has
   * no route to that address the request hangs until it times out. Measured
   * against the deployed server, six attempts through `fetch` lost three to
   * ETIMEDOUT and six attempts pinned to IPv4 lost none. So the address family
   * is chosen here, from what DNS actually returns, rather than left to a
   * racing algorithm whose losing branch is invisible.
   *
   * IPv4 is preferred because it is the address that works on the widest range
   * of networks, and IPv6 is used when it is the only thing there is. A
   * connection that dies before any answer comes back is retried once: nothing
   * was asked, nothing was answered, and both of these calls are read-only.
   */
  async function call<T>(path: string, body: Record<string, unknown>): Promise<T> {
    if (!baseUrl) throw new Error("no Web-Kit server is configured for this run");

    let response: Reply;
    let failure: unknown;
    try {
      response = await post(`${baseUrl}${path}`, body);
    } catch (first) {
      failure = first;
      await new Promise((done) => setTimeout(done, 250));
      try {
        response = await post(`${baseUrl}${path}`, body);
      } catch {
        throw new Error(`could not reach Web-Kit at ${baseUrl}: ${describe(failure)}`);
      }
    }

    const payload = JSON.parse(response.body || "{}") as T & {
      error?: { code: string; message: string };
    };
    if (response.status < 200 || response.status >= 300) {
      const code = payload.error?.code ?? String(response.status);
      throw new Error(`${code}: ${payload.error?.message ?? "the request failed"}`);
    }
    return payload;
  }

  async function post(target: string, body: Record<string, unknown>): Promise<Reply> {
    const url = new URL(target);
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const family = await familyFor(url.hostname);
    const text = JSON.stringify(body);

    return new Promise<Reply>((resolve, reject) => {
      const req = send(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          // The name stays the hostname, so TLS still gets the right SNI and the
          // certificate is still checked against the name that was asked for.
          // Only the family is pinned, which is what stops the unreachable AAAA
          // address from being dialled at all.
          family,
          servername: url.hostname,
          port: url.port || (url.protocol === "https:" ? 443 : 80),
          path: `${url.pathname}${url.search}`,
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(text),
            ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
          },
        },
        (res) => {
          let received = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            if (received.length < MAX_RESPONSE_BYTES) received += chunk;
          });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: received }));
          res.on("error", reject);
        },
      );
      req.setTimeout(timeout, () => req.destroy(new Error(`no answer within ${timeout}ms`)));
      req.on("error", reject);
      req.end(text);
    });
  }

  return [
    {
      name: "web.search",
      description:
        "Search the web. { query, limit }. Several providers are asked at once and their answers are ranked together, so a result they agree on comes first. Use it when you need a page you cannot name, not when you already know the address.",
      effect: "read",
      async call(input) {
        const args = parse(input, ["query", "limit", "providers", "mode"]);
        const query = text(args, "query");
        if (!query) throw new Error("web.search needs a query");
        const limit = number(args, "limit") ?? DEFAULT_RESULTS;
        const mode = text(args, "mode");
        const providers = list(args, "providers");
        const response = await call<SearchResponse>("/v1/search", {
          query,
          limit: Math.min(Math.max(limit, 1), 25),
          // fanout is the service default and the reason it is here at all;
          // "single" is one provider, "fallback" walks them in turn on failure.
          ...(mode === "single" || mode === "fallback" || mode === "fanout" ? { mode } : {}),
          ...(providers ? { providers } : {}),
        });

        if (response.results.length === 0) {
          const failed = Object.entries(response.providers)
            .filter(([, status]) => status.status !== "ok")
            .map(([id, status]) => `${id} (${status.error ?? status.status})`);
          return `no results for "${response.query}"${failed.length ? `; providers that did not answer: ${failed.join(", ")}` : ""}`;
        }

        const lines = response.results.map(
          (result) =>
            `${result.rank}. ${result.title}\n   ${result.url}\n   ${(result.snippet ?? "").slice(0, 240)}\n   via ${result.providers.join(", ")}`,
        );
        const footer = `(${response.results.length} results from ${Object.keys(response.providers).length} providers in ${response.timing.duration_ms}ms)`;
        const warnings = response.warnings.length ? `\nwarnings: ${response.warnings.join("; ")}` : "";
        return cap(`${lines.join("\n")}\n${footer}${warnings}`);
      },
    },
    {
      name: "web.fetch",
      description:
        "Fetch one page and return it as text. { url, mode }. markdown keeps headings and links, text drops them, metadata returns only the title and description. Use it on a url that web.search returned.",
      effect: "read",
      async call(input) {
        const args = parse(input, ["url", "mode"]);
        const url = text(args, "url");
        if (!url) throw new Error("web.fetch needs a url");
        const mode = text(args, "mode");
        const response = await call<FetchResponse>("/v1/fetch", {
          url,
          mode: mode === "text" || mode === "metadata" || mode === "raw" ? mode : "markdown",
        });

        // An image or a PDF comes back with everything null, so nothing here may
        // assume the metadata block is there.
        const { title, description } = response.document.metadata ?? { title: null, description: null };
        const body =
          response.document.markdown ??
          response.document.text ??
          description ??
          // The header line above already carries the title, so repeating it
          // here would only crowd out the fact that matters: nothing came back.
          `(no text was returned; this is ${response.retrieval.content_type ?? "not a readable document"})`;
        const head = `${response.retrieval.final_url}\n(${response.retrieval.status}, ${title ?? response.retrieval.content_type ?? "unknown type"}, ${response.retrieval.bytes} bytes)`;
        const warnings = response.warnings.length ? `\nwarnings: ${response.warnings.join("; ")}` : "";
        return cap(`${head}\n\n${body}${warnings}`);
      },
    },
  ];
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: { code?: string; errors?: { code?: string }[] } }).cause;
    return cause?.code ?? cause?.errors?.[0]?.code ?? error.message;
  }
  return String(error);
}

function cap(text: string): string {
  if (text.length <= MAX_OUTPUT) return text;
  return `${text.slice(0, MAX_OUTPUT)}\n... cut off, ${text.length} characters in total`;
}

/**
 * Reads the arguments from JSON or from `key: value` pairs.
 *
 * The keys are listed by the caller so that `limit: 5` is read as a number and
 * `url: https://x.test` keeps its slashes, which a generic field guesser gets
 * wrong often enough to matter.
 */
function parse(input: string, keys: string[]): Record<string, string> {
  const trimmed = input.trim();
  if (!trimmed) return {};
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed) as Record<string, string>;
    } catch {
      throw new Error(`arguments were not valid JSON: ${trimmed.slice(0, 80)}`);
    }
  }
  const args: Record<string, string> = {};
  const known = new Set(keys);
  const re = /([a-z]+):\s*([\s\S]*?)(?=\s+[a-z]+:\s|$)/gi;
  for (const match of trimmed.matchAll(re)) {
    const key = match[1]!.toLowerCase();
    if (known.has(key)) args[key] = match[2]!.trim();
  }
  if (Object.keys(args).length === 0 && known.has("query")) return { query: trimmed };
  if (Object.keys(args).length === 0 && known.has("url")) return { url: trimmed };
  return args;
}

function text(args: Record<string, string>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function number(args: Record<string, string>, key: string): number | undefined {
  const value = Number(text(args, key));
  return Number.isFinite(value) ? value : undefined;
}

function list(args: Record<string, string>, key: string): string[] | undefined {
  const value = text(args, key);
  if (!value) return undefined;
  const parts = value.split(/[,\s]+/).filter(Boolean);
  return parts.length ? parts : undefined;
}
