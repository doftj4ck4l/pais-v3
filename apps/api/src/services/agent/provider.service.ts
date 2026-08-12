import type { ModelConfig } from "../../catalog/llm-models";
import { effectiveApiKey } from "../../catalog/llm-models";
import type { AssistantChunk, ChatMessage, ToolSchema } from "../../types/chat";

/**
 * A message as the provider takes it.
 *
 * Wider than `ChatMessage` in exactly one way: a system turn. `ChatRole` does
 * not include one because a *conversation* never contains one — the system
 * prompt is assembled per request and is not part of the history the user sees
 * or the transcript stores. A caller doing a one-shot completion with its own
 * instructions still needs to send one.
 */
export type ProviderMessage = ChatMessage | { role: "system"; content: string };

/**
 * Minimal OpenAI-compatible streaming chat client.
 * Returns accumulated text + tool_calls once the stream finishes.
 */
export async function chatOnce(
  model: ModelConfig,
  messages: ProviderMessage[],
  tools: ToolSchema[],
): Promise<AssistantChunk> {
  if (model.provider === "mock") return mockOnce(messages);

  const key = effectiveApiKey(model);
  if (!key) {
    throw new Error(
      `No API key for ${model.id} — add ${model.apiKeyEnv} to apps/api/.env or configure the Custom model in the UI`,
    );
  }

  const body = {
    model: model.model,
    messages,
    tools: tools.length ? tools : undefined,
    stream: true,
  };

  const res = await fetch(`${model.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`provider error ${res.status}: ${text}`);
  }

  return parseStream(res.body);
}

async function parseStream(body: ReadableStream<Uint8Array>): Promise<AssistantChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  let text = "";
  let reasoningContent = "";
  const toolCalls: { id: string; name: string; args: string }[] = [];

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      let json: any;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      const delta = json?.choices?.[0]?.delta;
      if (!delta) continue;
      if (typeof delta.content === "string") text += delta.content;
      if (typeof delta.reasoning_content === "string") reasoningContent += delta.reasoning_content;
      for (const tc of delta.tool_calls ?? []) {
        const index = tc.index ?? 0;
        toolCalls[index] ??= { id: "", name: "", args: "" };
        if (tc.id) toolCalls[index].id = tc.id;
        if (tc.function?.name) toolCalls[index].name += tc.function.name;
        if (tc.function?.arguments) toolCalls[index].args += tc.function.arguments;
      }
    }
  }

  return {
    text,
    reasoningContent,
    toolCalls: toolCalls
      .filter((t) => t)
      .map((t) => {
        let args: Record<string, unknown> = {};
        try {
          args = t.args ? JSON.parse(t.args) : {};
        } catch {
          args = { raw: t.args };
        }
        return { id: t.id || `call_${Math.random().toString(36).slice(2)}`, name: t.name, args };
      }),
  };
}

/** Offline demo provider so the UI works with zero API keys. */
function mockOnce(messages: ProviderMessage[]): AssistantChunk {
  const last = messages[messages.length - 1];

  // After the model has called a tool, the agent appends its result as the
  // final "tool" message. Finish the loop by summarizing that result rather
  // than triggering the same tool again (stops the offline demo from looping).
  if (last?.role === "tool") {
    const result = last.content ?? "";
    const name = last.name ?? "tool";
    return {
      text: `[mock model] Result of \`${name}\`: ${result}`,
      reasoningContent: "",
      toolCalls: [],
    };
  }

  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const text = lastUser?.content ?? "";
  const has = (re: RegExp) => re.test(text);

  if (has(/calc|calculator|\d\s*[-+*/]/)) {
    const m = text.match(/\d[\d+\-*/().\s]*/);
    const expr = m?.[0] ?? "2+2";
    return {
      text: "",
      reasoningContent: "",
      toolCalls: [
        {
          id: `call_${Math.random().toString(36).slice(2)}`,
          name: "calculator",
          args: { expression: expr },
        },
      ],
    };
  }
  if (has(/time|date|now/)) {
    return {
      text: "",
      reasoningContent: "",
      toolCalls: [
        {
          id: `call_${Math.random().toString(36).slice(2)}`,
          name: "get_current_time",
          args: {},
        },
      ],
    };
  }
  if (has(/\bweather\b|forecast|temp/)) {
    const m = text.match(/in\s+([a-z\s]+)/i);
    return {
      text: "",
      reasoningContent: "",
      toolCalls: [
        {
          id: `call_${Math.random().toString(36).slice(2)}`,
          name: "get_weather",
          args: { city: m?.[1]?.trim() ?? "Kuala Lumpur" },
        },
      ],
    };
  }
  if (has(/\brandom\b|dice|roll/)) {
    return {
      text: "",
      reasoningContent: "",
      toolCalls: [
        {
          id: `call_${Math.random().toString(36).slice(2)}`,
          name: "random_number",
          args: {},
        },
      ],
    };
  }
  return {
    text: `[mock model] You asked: "${text.slice(0, 60)}". This is a canned reply because no API key is configured. Add \`OPENAI_API_KEY\` or \`DEEPSEEK_API_KEY\` to apps/api/.env to hit a real model, or ask something with "calculator" or "time" to see the tool loop work offline.`,
    reasoningContent: "",
    toolCalls: [],
  };
}
