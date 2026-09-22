import { describe, expect, it } from "bun:test";
import type { ModelConfig } from "../../catalog/llm-models";
import { chatOnce } from "./provider.service";

describe("one-shot provider client", () => {
  it("streams text, reasoning, and usage to observers without changing the request shape", async () => {
    let request: Record<string, unknown> = {};
    const provider = Bun.serve({
      port: 0,
      async fetch(req) {
        request = (await req.json()) as Record<string, unknown>;
        return new Response(
          [
            'data: {"choices":[{"delta":{"reasoning_content":"Think "}}]}',
            'data: {"choices":[{"delta":{"content":"Hello"}}]}',
            'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":7,"completion_tokens":2}}',
            "data: [DONE]",
            "",
          ].join("\n\n"),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const model: ModelConfig = {
      id: "observer-test",
      label: "Observer test",
      provider: "custom",
      model: "observer-test",
      apiKeyEnv: "UNUSED_TEST_API_KEY",
      apiKey: "test-key",
      baseUrl: `http://127.0.0.1:${provider.port}/v1`,
      hint: "",
      brand: "",
      contextWindow: 8_192,
    };
    const text: string[] = [];
    const reasoning: string[] = [];
    const usage: { input: number; output: number }[] = [];

    try {
      const result = await chatOnce(model, [{ role: "user", content: "Hello" }], [], undefined, {
        onTextDelta: (delta) => text.push(delta),
        onReasoningDelta: (delta) => reasoning.push(delta),
        onUsage: (value) => usage.push(value),
      });

      expect(result).toMatchObject({ text: "Hello", reasoningContent: "Think " });
      expect(text).toEqual(["Hello"]);
      expect(reasoning).toEqual(["Think "]);
      expect(usage).toEqual([{ input: 7, output: 2 }]);
      expect(request.stream_options).toBeUndefined();
    } finally {
      provider.stop(true);
    }
  });

  it("aborts while an OpenAI-compatible response stream is still open", async () => {
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    const provider = Bun.serve({
      port: 0,
      fetch() {
        requestStarted();
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
                ),
              );
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const model: ModelConfig = {
      id: "abort-test",
      label: "Abort test",
      provider: "custom",
      model: "abort-test",
      apiKeyEnv: "UNUSED_TEST_API_KEY",
      apiKey: "test-key",
      baseUrl: `http://127.0.0.1:${provider.port}/v1`,
      hint: "",
      brand: "",
      contextWindow: 8_192,
    };
    const abort = new AbortController();

    try {
      const pending = chatOnce(model, [{ role: "user", content: "Hello" }], [], abort.signal);
      await started;
      await Bun.sleep(10);
      abort.abort(new Error("agent invocation timed out"));

      await expect(pending).rejects.toThrow("agent invocation timed out");
    } finally {
      provider.stop(true);
    }
  });
});
