export type Message = {
  role: "user" | "assistant" | "tool";
  content: string;
  /** The tool this message came from or went to. */
  name?: string;
  /**
   * Kept so a provider that links tool results by id, such as any OpenAI
   * compatible endpoint, can be given the pairing back.
   */
  toolCalls?: Array<{ id: string; name: string; input: string }>;
  /** The id of the tool call this message answers. */
  callId?: string;
};

export type ToolSpec = {
  name: string;
  description: string;
  /** JSON Schema for the arguments, when the tool has one worth declaring. */
  schema?: unknown;
};

export type Completion =
  | { type: "text"; content: string }
  | {
      type: "toolCalls";
      /** Some models return prose alongside the calls. */
      content?: string;
      calls: Array<{ id: string; name: string; input: string }>;
    };

export type ModelClient = {
  complete(req: {
    system: string;
    messages: Message[];
    tools: ToolSpec[];
    stepsLeft: number;
    /** The id this run answers to, so a provider can carry it. */
    id: string;
    /** Messages other agents sent this run while it was working. */
    inbox: Array<{ from: string; body: string }>;
  }): Promise<Completion>;
};
