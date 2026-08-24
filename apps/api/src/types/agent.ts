/** Everything the agent loop streams back to the client, one event per SSE frame. */
export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown> }
  | {
      type: "tool_result";
      /**
       * The call this answers. Optional only because a result can be replayed
       * from a stored transcript that predates it; live runs always carry it,
       * and without it a batch of parallel calls to one tool cannot be paired
       * back to its arguments.
       */
      id?: string;
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
  /**
   * The agent is asking the user a question and waiting for the answer. Emitted
   * by the `ask_user` tool, which blocks the in-progress run until the user
   * responds (or the run is stopped). Live-only — the tool call and its result
   * carry the durable record, so the recorder ignores this event.
   */
  | {
      type: "ask_user";
      id: string;
      question: string;
      options: string[];
      /** Approval prompts use fixed allow/deny actions rather than free text. */
      kind: "question" | "approval";
    }
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
  /**
   * Which workspace this run belongs to. Its documents, databases, memory and
   * sandbox are the ones the agent can reach.
   *
   * This is the run's only scope. It is always a value that
   * `workspaceRegistry.resolve` has already checked against ownership — there
   * is deliberately no user id here to fall back on, because falling back
   * would mean running against a scope nobody owns.
   */
  workspaceId?: string;
  /**
   * The chat session this run continues. Carried only so anything the run
   * produces — an image so far — is stamped with it, which is what lets the
   * console show one session's artifacts rather than the whole workspace's.
   */
  conversationId?: string;
  /**
   * How hard a thinking model should reason this run — one of the model's own
   * effort levels. Ignored by models that do not declare `thinking`; when a
   * thinking model gets none, its default level is used.
   */
  reasoningEffort?: string;
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
  /** Images the user attached to this message, as ids from POST /api/images. */
  imageIds?: string[];
  /** CSV/XLSX paths uploaded into this workspace by POST /api/workspace/files. */
  filePaths?: string[];
  /** Which workspace this run belongs to. Resolved server-side when absent. */
  workspaceId?: string;
  /** How hard a thinking model should reason — one of its declared effort levels. */
  reasoningEffort?: string;
};
