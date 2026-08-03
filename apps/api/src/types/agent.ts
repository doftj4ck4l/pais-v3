/** Everything the agent loop streams back to the client, one event per SSE frame. */
export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown> }
  | {
      type: "tool_result";
      name: string;
      content: string;
      calls: number;
      /** Wall-clock duration of the call, absent if the start was not seen. */
      ms?: number;
      /** False when the tool reported a failure rather than a usable result. */
      ok?: boolean;
    }
  | { type: "iteration"; iteration: number }
  | { type: "trace"; step: string; fields: Record<string, unknown> }
  | {
      type: "slots";
      mode: "tools" | "queue";
      tools?: string[];
      steer?: number;
      followUp?: number;
    }
  | { type: "done"; turns: number }
  | { type: "error"; message: string }
  /** Sent once, up front: the row this run is being stored as. */
  | { type: "conversation"; id: string }
  /**
   * Context budget for this turn. Emitted before the run (the prompt's cost is
   * known up front) and again after, once the provider reports what it actually
   * charged.
   */
  | {
      type: "context";
      /** Tokens the conversation currently occupies. */
      used: number;
      /** The model's usable window. */
      window: number;
      /** True when `used` is a heuristic rather than provider-reported. */
      estimated: boolean;
      /** Set when older turns were summarised to fit. */
      compacted?: { fromTokens: number; toTokens: number; turnsSummarised: number };
    };

export type AgentOptions = {
  signal?: AbortSignal;
  runId?: string;
  /** Run via a loaded prompt template instead of the raw last user message. */
  template?: { name: string; args?: string[] };
  /** Workspace dir for the built-in file/shell tools. */
  workspace?: string;
  /** User id for per-user long-term memory. */
  userId?: string;
};

/** Body accepted by POST /api/chat. */
export type ChatRequest = {
  /**
   * Continue this conversation instead of starting one. The row must belong to
   * the requesting user; anything else starts a new conversation rather than
   * failing, so a stale client id can never write into someone else's thread.
   */
  conversationId?: string;
  harnessId?: string;
  modelId?: string;
  messages?: import("./chat").ChatMessage[];
  modelConfig?: { baseUrl?: string; model?: string; apiKey?: string };
  template?: { name: string; args?: string[] };
  workspace?: string;
  userId?: string;
};
