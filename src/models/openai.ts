import type { Completion, Message, ModelClient, ToolSpec } from "../model.js";

export type OpenAICompatibleOptions = {
  /** Whatever the endpoint calls it: gpt-5.2, llama-3.3-70b, qwen3-coder, ... */
  model: string;
  /** Defaults to https://api.openai.com/v1. Point it anywhere else. */
  baseUrl?: string | undefined;
  apiKey?: string | undefined;
  temperature?: number;
  /** Sent as max_completion_tokens, the current field. */
  maxTokens?: number;
  /** Newer reasoning models want developer instead of system. */
  systemRole?: "system" | "developer";
  /** Extra headers, for endpoints that want a project or version id. */
  headers?: Record<string, string>;
  /** Injected in tests. Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Called after every request. Never receives the key. */
  onUsage?: (usage: Usage) => void;
};

export type Usage = {
  model: string;
  promptTokens?: number | undefined;
  completionTokens?: number | undefined;
  totalTokens?: number | undefined;
};

/**
 * Talks to anything that speaks the OpenAI chat completions protocol, which is
 * most hosted and local model servers. One adapter, provider swapped by config.
 */
export class OpenAICompatible implements ModelClient {
  private readonly baseUrl: string;
  private readonly send: typeof fetch;
  private counter = 0;
  private readonly options: OpenAICompatibleOptions;

  // Written out longhand rather than as a parameter property: Node runs this
  // file directly with type stripping, which cannot erase a parameter property
  // because that construct emits code rather than only types.
  constructor(options: OpenAICompatibleOptions) {
    this.options = options;
    this.baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    this.send = options.fetch ?? fetch;
  }

  async complete(req: Parameters<ModelClient["complete"]>[0]): Promise<Completion> {
    const body = {
      model: this.options.model,
      messages: this.wire(req.system, req.messages),
      ...(req.tools.length > 0 ? { tools: req.tools.map(toWireTool), tool_choice: "auto" } : {}),
      ...(this.options.temperature === undefined
        ? {}
        : { temperature: this.options.temperature }),
      ...(this.options.maxTokens === undefined
        ? {}
        : { max_completion_tokens: this.options.maxTokens }),
      stream: false,
    };

    const response = await this.send(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
        ...this.options.headers,
      },
      body: JSON.stringify(body),
    });

    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`${response.status} from ${this.options.model}: ${raw.slice(0, 500)}`);
    }

    const payload = JSON.parse(raw) as ChatCompletion;
    this.options.onUsage?.({
      model: payload.model ?? this.options.model,
      promptTokens: payload.usage?.prompt_tokens,
      completionTokens: payload.usage?.completion_tokens,
      totalTokens: payload.usage?.total_tokens,
    });

    const message = payload.choices?.[0]?.message;
    if (!message) throw new Error(`${this.options.model} returned no choices`);

    const calls = (message.tool_calls ?? [])
      .filter((call) => call.type === "function" || call.type === undefined)
      .map((call) => ({
        id: call.id ?? `call_${++this.counter}`,
        name: call.function?.name ?? "",
        input: call.function?.arguments ?? "",
      }))
      .filter((call) => call.name !== "");

    if (calls.length === 0) {
      return { type: "text", content: message.content ?? "" };
    }
    return message.content
      ? { type: "toolCalls", content: message.content, calls }
      : { type: "toolCalls", calls };
  }

  /** The markdown file becomes the system message. Everything else maps flat. */
  private wire(system: string, messages: Message[]): unknown[] {
    const out: unknown[] = [
      { role: this.options.systemRole ?? "system", content: system },
    ];

    for (const message of messages) {
      if (message.role === "user") {
        out.push({ role: "user", content: message.content });
        continue;
      }

      if (message.role === "tool") {
        // OpenAI requires every tool result to name the call it answers.
        out.push({
          role: "tool",
          tool_call_id: message.callId ?? `call_${++this.counter}`,
          content: message.content,
        });
        continue;
      }

      if (message.toolCalls && message.toolCalls.length > 0) {
        out.push({
          role: "assistant",
          content: message.content || null,
          tool_calls: message.toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: call.input || "{}" },
          })),
        });
        continue;
      }

      out.push({ role: "assistant", content: message.content });
    }

    return out;
  }
}

/**
 * Our tools take one string, so the schema stays open by default and the model
 * is free to send the object shape the description tells it about.
 */
function toWireTool(spec: ToolSpec) {
  return {
    type: "function",
    function: {
      name: spec.name,
      description: spec.description,
      parameters: (spec.schema as { parameters?: unknown })?.parameters ?? {
        type: "object",
        additionalProperties: true,
      },
    },
  };
}

type ChatCompletion = {
  model?: string;
  choices?: Array<{
    finish_reason?: string;
    message?: {
      role?: string;
      content?: string | null;
      tool_calls?: Array<{
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};

/**
 * Reads the environment only. Never touches a file, never logs the key.
 * OPENAI_BASE_URL is what makes this usable against a local server.
 */
export function openAIFromEnv(env: NodeJS.ProcessEnv = process.env): OpenAICompatible {
  const model = env["NGI_MODEL"] ?? env["OPENAI_MODEL"];
  if (!model) {
    throw new Error("set NGI_MODEL, for example NGI_MODEL=gpt-5.2");
  }
  const apiKey = env["NGI_API_KEY"] ?? env["OPENAI_API_KEY"];
  const baseUrl = env["NGI_BASE_URL"] ?? env["OPENAI_BASE_URL"];
  if (!apiKey && !baseUrl) {
    throw new Error("set NGI_API_KEY, or set NGI_BASE_URL for a server that needs no key");
  }
  return new OpenAICompatible({ model, apiKey, baseUrl });
}
