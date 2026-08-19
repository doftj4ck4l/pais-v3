import { describe, expect, it } from "bun:test";
import type { ModelConfig } from "../../catalog/llm-models";
import { chatOnce } from "./provider.service";

describe("one-shot provider client", () => {
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
