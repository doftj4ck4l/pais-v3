/** Wire types for the OpenAI-compatible chat-completions protocol. */

export type ChatRole = "user" | "assistant" | "tool";

export type ChatMessage = {
  role: ChatRole;
  content?: string;
  tool_call_id?: string;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
  name?: string;
};

/** One assistant turn, accumulated from a finished stream. */
export type AssistantChunk = {
  text: string;
  reasoningContent: string;
  toolCalls: { id: string; name: string; args: Record<string, unknown> }[];
};

export type ToolSchema = { type: "function"; function: Record<string, unknown> };
