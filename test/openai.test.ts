import { describe, expect, it } from "vitest";
import { OpenAICompatible, openAIFromEnv } from "../src/models/openai.js";
import { run } from "../src/run.js";
import { Tools } from "../src/tools.js";

type Sent = { url: string; init: RequestInit };

function stub(payload: unknown, status = 200) {
  const sent: Sent[] = [];
  const fetchStub = (async (url: string | URL | Request, init: RequestInit) => {
    sent.push({ url: String(url), init });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { sent, fetchStub };
}

const textReply = (content: string) => ({
  model: "test-model",
  choices: [{ finish_reason: "stop", message: { role: "assistant", content } }],
});

const toolReply = (calls: Array<{ name: string; arguments: string }>) => ({
  model: "test-model",
  choices: [
    {
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        tool_calls: calls.map((call, index) => ({
          id: `call_${index}`,
          type: "function",
          function: call,
        })),
      },
    },
  ],
});

const request = {
  system: "# Agent\ndo the thing",
  messages: [{ role: "user" as const, content: "build it" }],
  tools: [{ name: "fs.read", description: "read a file" }],
  stepsLeft: 5,
  id: "agent-1",
  inbox: [],
};

describe("openai compatible adapter", () => {
  it("posts to the chat completions endpoint with the key as a bearer", async () => {
    const { sent, fetchStub } = stub(textReply("done"));
    const model = new OpenAICompatible({
      model: "gpt-5.2",
      apiKey: "sk-test",
      fetch: fetchStub,
    });

    const out = await model.complete(request);

    expect(sent[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(sent[0]?.init.method).toBe("POST");
    const headers = sent[0]?.init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer sk-test");
    expect(out).toEqual({ type: "text", content: "done" });
  });

  it("sends the markdown as the system message", async () => {
    const { sent, fetchStub } = stub(textReply("ok"));
    await new OpenAICompatible({ model: "m", apiKey: "k", fetch: fetchStub }).complete(request);

    const body = JSON.parse(sent[0]!.init.body as string);
    expect(body.messages[0]).toEqual({ role: "system", content: "# Agent\ndo the thing" });
    expect(body.messages[1]).toEqual({ role: "user", content: "build it" });
    expect(body.model).toBe("m");
    expect(body.stream).toBe(false);
  });

  it("uses developer instead of system when asked", async () => {
    const { sent, fetchStub } = stub(textReply("ok"));
    await new OpenAICompatible({
      model: "m",
      apiKey: "k",
      fetch: fetchStub,
      systemRole: "developer",
    }).complete(request);
    expect(JSON.parse(sent[0]!.init.body as string).messages[0].role).toBe("developer");
  });

  it("declares tools as function tools and omits them when there are none", async () => {
    const { sent, fetchStub } = stub(textReply("ok"));
    const model = new OpenAICompatible({ model: "m", apiKey: "k", fetch: fetchStub });

    await model.complete(request);
    const withTools = JSON.parse(sent[0]!.init.body as string);
    expect(withTools.tools[0]).toEqual({
      type: "function",
      function: {
        name: "fs.read",
        description: "read a file",
        parameters: { type: "object", additionalProperties: true },
      },
    });
    expect(withTools.tool_choice).toBe("auto");

    await model.complete({ ...request, tools: [] });
    const without = JSON.parse(sent[1]!.init.body as string);
    expect(without.tools).toBeUndefined();
  });

  it("passes a declared schema through", async () => {
    const { sent, fetchStub } = stub(textReply("ok"));
    await new OpenAICompatible({ model: "m", apiKey: "k", fetch: fetchStub }).complete({
      ...request,
      tools: [
        {
          name: "fs.write",
          description: "write",
          schema: { parameters: { type: "object", required: ["path"] } },
        },
      ],
    });
    const body = JSON.parse(sent[0]!.init.body as string);
    expect(body.tools[0].function.parameters).toEqual({ type: "object", required: ["path"] });
  });

  it("turns a tool_calls reply into calls, keeping the ids", async () => {
    const { fetchStub } = stub(
      toolReply([
        { name: "fs.read", arguments: '{"path":"a.ts"}' },
        { name: "fs.write", arguments: '{"path":"b.ts","content":"x"}' },
      ]),
    );
    const out = await new OpenAICompatible({ model: "m", apiKey: "k", fetch: fetchStub }).complete(
      request,
    );

    expect(out).toEqual({
      type: "toolCalls",
      calls: [
        { id: "call_0", name: "fs.read", input: '{"path":"a.ts"}' },
        { id: "call_1", name: "fs.write", input: '{"path":"b.ts","content":"x"}' },
      ],
    });
  });

  it("links every tool result back to the call it answers", async () => {
    const { sent, fetchStub } = stub(textReply("finished"));
    await new OpenAICompatible({ model: "m", apiKey: "k", fetch: fetchStub }).complete({
      ...request,
      messages: [
        { role: "user", content: "read it" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call_7", name: "fs.read", input: '{"path":"a.ts"}' }],
        },
        { role: "tool", content: "the contents", name: "fs.read", callId: "call_7" },
      ],
    });

    const body = JSON.parse(sent[0]!.init.body as string);
    expect(body.messages[2]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "call_7", type: "function", function: { name: "fs.read", arguments: '{"path":"a.ts"}' } },
      ],
    });
    expect(body.messages[3]).toEqual({
      role: "tool",
      tool_call_id: "call_7",
      content: "the contents",
    });
  });

  it("throws with the status and the body when the endpoint refuses", async () => {
    const { fetchStub } = stub({ error: { message: "bad key" } }, 401);
    await expect(
      new OpenAICompatible({ model: "m", apiKey: "k", fetch: fetchStub }).complete(request),
    ).rejects.toThrow("401 from m");
  });

  it("reports usage when the endpoint sends it", async () => {
    const payload = {
      ...textReply("ok"),
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    };
    const { fetchStub } = stub(payload);
    const seen: unknown[] = [];
    await new OpenAICompatible({
      model: "m",
      apiKey: "k",
      fetch: fetchStub,
      onUsage: (usage) => seen.push(usage),
    }).complete(request);

    expect(seen).toEqual([
      { model: "test-model", promptTokens: 10, completionTokens: 4, totalTokens: 14 },
    ]);
  });

  it("works against any base url, so one adapter covers every server", async () => {
    const { sent, fetchStub } = stub(textReply("ok"));
    await new OpenAICompatible({
      model: "qwen3-coder",
      baseUrl: "http://localhost:11434/v1/",
      fetch: fetchStub,
    }).complete(request);

    expect(sent[0]?.url).toBe("http://localhost:11434/v1/chat/completions");
    expect((sent[0]?.init.headers as Record<string, string>)["authorization"]).toBeUndefined();
  });

  it("drives a real run loop end to end", async () => {
    const replies = [
      toolReply([{ name: "fs.read", arguments: '{"path":"a.ts"}' }]),
      textReply("read it, all done. completed: true"),
    ];
    let turn = 0;
    const fetchStub = (async () =>
      new Response(JSON.stringify(replies[turn++]!), {
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    const tools = new Tools().add({
      name: "fs.read",
      description: "read a file",
      effect: "read",
      call: () => "export const a = 1;",
    });

    const result = await run({
      model: new OpenAICompatible({ model: "m", apiKey: "k", fetch: fetchStub }),
      system: "# Agent",
      message: "read a.ts",
      tools,
    });

    expect(result.text).toContain("completed: true");
    expect(result.toolCalls).toEqual(["fs.read"]);
    expect(turn).toBe(2);
  });
});

describe("openAIFromEnv", () => {
  it("reads the model and key from the environment and nothing else", () => {
    const model = openAIFromEnv({ NGI_MODEL: "gpt-5.2", NGI_API_KEY: "k" } as NodeJS.ProcessEnv);
    expect(model).toBeInstanceOf(OpenAICompatible);
  });

  it("falls back to the OPENAI_ names", () => {
    expect(() =>
      openAIFromEnv({ OPENAI_MODEL: "gpt-5.2", OPENAI_API_KEY: "k" } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });

  it("allows a base url with no key, for a local server", () => {
    expect(() =>
      openAIFromEnv({ NGI_MODEL: "llama3", NGI_BASE_URL: "http://localhost:11434/v1" } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });

  it("refuses to start without a model", () => {
    expect(() => openAIFromEnv({} as NodeJS.ProcessEnv)).toThrow("NGI_MODEL");
  });

  it("refuses to start with neither a key nor a base url", () => {
    expect(() => openAIFromEnv({ NGI_MODEL: "gpt-5.2" } as NodeJS.ProcessEnv)).toThrow(
      "NGI_API_KEY",
    );
  });
});
