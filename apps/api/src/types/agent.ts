/** Everything the agent loop streams back to the client, one event per SSE frame. */
export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; name: string; content: string; calls: number }
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
  | { type: "conversation"; id: string };

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
  harnessId?: string;
  modelId?: string;
  messages?: import("./chat").ChatMessage[];
  modelConfig?: { baseUrl?: string; model?: string; apiKey?: string };
  template?: { name: string; args?: string[] };
  workspace?: string;
  userId?: string;
};
