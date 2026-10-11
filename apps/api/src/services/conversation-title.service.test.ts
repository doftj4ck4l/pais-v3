import { describe, expect, test } from "bun:test";
import { generateTitle, normaliseTitle } from "./conversation-title.service";
import type { ModelConfig } from "../catalog/llm-models";

const model = { id: "test-model", provider: "mock" } as unknown as ModelConfig;

describe("normaliseTitle", () => {
  test("strips packaging a one-line reply tends to carry", () => {
    expect(normaliseTitle('Intent Routing for AI Harness')).toBe("Intent Routing for AI Harness");
    expect(normaliseTitle('"Intent Routing for AI Harness"')).toBe("Intent Routing for AI Harness");
    expect(normaliseTitle("3-Day Powerlifting Routine.")).toBe("3-Day Powerlifting Routine");
    expect(normaliseTitle("Title: Telegram Complaint Platform")).toBe("Telegram Complaint Platform");
    expect(normaliseTitle("  lots   of   spaces  ")).toBe("lots of spaces");
  });

  test("caps the length and rejects empties", () => {
    expect(normaliseTitle("")).toBe("");
    expect(normaliseTitle('""')).toBe("");
    expect(normaliseTitle("x".repeat(200)).length).toBe(80);
  });
});

describe("generateTitle", () => {
  const history = [
    { role: "user", content: "I'm using Pi as the harness. How should I implement intent routing?" },
  ];

  test("stores the normalised model reply and reports it", async () => {
    const saved: string[] = [];
    const title = await generateTitle(
      { workspaceId: "ws1", conversationId: "conv_1", model, history },
      {
        setTitle: (_id, _wsId, title) => {
          saved.push(title);
          return Promise.resolve(true);
        },
      },
      async () => ({ text: '"Intent Routing for the Harness"\n' }) as any,
    );
    expect(title).toBe("Intent Routing for the Harness");
    expect(saved).toEqual(["Intent Routing for the Harness"]);
  });

  test("gives up quietly on an unusable reply", async () => {
    const title = await generateTitle(
      { workspaceId: "ws1", conversationId: "conv_1", model, history },
      { setTitle: () => Promise.resolve(true) },
      async () => ({ text: "   " }) as any,
    );
    expect(title).toBeNull();
  });

  test("skips the job entirely when the first turn is empty", async () => {
    let called = 0;
    const title = await generateTitle(
      { workspaceId: "ws1", conversationId: "conv_1", model, history: [{ role: "user", content: "" }] },
      { setTitle: () => { called += 1; return Promise.resolve(true); } },
      async () => ({ text: "unused" }) as any,
    );
    expect(title).toBeNull();
    expect(called).toBe(0);
  });

  test("a failed store write is reported as no title, not a throw", async () => {
    const title = await generateTitle(
      { workspaceId: "ws1", conversationId: "conv_1", model, history },
      { setTitle: () => Promise.reject(new Error("db gone")) },
      async () => ({ text: "Some Title" }) as any,
    );
    expect(title).toBeNull();
  });
});
