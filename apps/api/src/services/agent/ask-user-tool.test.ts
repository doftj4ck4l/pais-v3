import { describe, expect, it } from "bun:test";
import type { AgentEvent } from "../../types/agent";
import { createAskUserTool } from "./ask-user-tool";
import { answerQuestion } from "./elicitation-registry";

/**
 * The tool must: emit an ask_user event carrying the question and options,
 * block until an answer arrives and then return exactly what the user said, and
 * release the wait — returning a plain "no answer" result — when the run aborts.
 */

describe("ask_user tool", () => {
  it("emits the question then resolves with the user's answer", async () => {
    const events: AgentEvent[] = [];
    const tool = createAskUserTool("conv1", (e) => events.push(e));

    // Start the call but do not await yet — it blocks until answered.
    const pending = tool.execute("call1", { question: "Which calendar?", options: ["Google", "Nextcloud"] });

    const asked = events.find((e) => e.type === "ask_user");
    expect(asked).toBeTruthy();
    if (asked?.type !== "ask_user") throw new Error("no ask_user event");
    expect(asked.question).toBe("Which calendar?");
    expect(asked.options).toEqual(["Google", "Nextcloud"]);

    // The answer arrives on the second request.
    expect(answerQuestion("conv1", asked.id, "Google")).toBe(true);

    const result = await pending;
    expect(result.details.output).toBe('The user answered: "Google"');
  });

  it("returns a no-answer result when the run aborts before a reply", async () => {
    const events: AgentEvent[] = [];
    const tool = createAskUserTool("conv1", (e) => events.push(e));
    const controller = new AbortController();

    const pending = tool.execute("call2", { question: "Anything?" }, controller.signal);
    controller.abort();

    const result = await pending;
    expect(result.details.output).toContain("No answer");
    // The question was cancelled, so a late answer finds nothing waiting.
    const asked = events.find((e) => e.type === "ask_user");
    if (asked?.type !== "ask_user") throw new Error("no ask_user event");
    expect(answerQuestion("conv1", asked.id, "late")).toBe(false);
  });

  it("refuses an empty question without emitting", async () => {
    const events: AgentEvent[] = [];
    const tool = createAskUserTool("conv1", (e) => events.push(e));
    const result = await tool.execute("call3", { question: "  " });
    expect(result.details.output).toContain("error");
    expect(events.length).toBe(0);
  });
});
