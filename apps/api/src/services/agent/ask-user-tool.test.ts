import { describe, expect, it } from "bun:test";
import type { AgentEvent } from "../../types/agent";
import { createAskUserTool, createUserInputRequester } from "./ask-user-tool";
import { answerQuestion } from "./elicitation-registry";

/**
 * The tool must: emit an ask_user event carrying the question and options,
 * block until an answer arrives and then return exactly what the user said, and
 * release the wait — returning a plain "no answer" result — when the run aborts.
 */

describe("ask_user tool", () => {
  it("emits the question then resolves with the user's answer", async () => {
    const events: AgentEvent[] = [];
    const tool = createAskUserTool(createUserInputRequester("conv1", (e) => events.push(e)));

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
    const tool = createAskUserTool(createUserInputRequester("conv1", (e) => events.push(e)));
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
    const tool = createAskUserTool(createUserInputRequester("conv1", (e) => events.push(e)));
    const result = await tool.execute("call3", { question: "  " });
    expect(result.details.output).toContain("error");
    expect(events.length).toBe(0);
  });
});

describe("user input requester", () => {
  it("serializes concurrent prompts so each one remains answerable", async () => {
    const events: AgentEvent[] = [];
    const request = createUserInputRequester("conv1", (event) => events.push(event));

    const first = request({ question: "Allow the first change?", options: ["Allow once", "Deny"], kind: "approval" });
    const second = request({ question: "Allow the second change?", options: ["Allow once", "Deny"], kind: "approval" });

    const firstEvent = events.find((event) => event.type === "ask_user");
    if (firstEvent?.type !== "ask_user") throw new Error("first prompt was not emitted");
    expect(firstEvent.question).toBe("Allow the first change?");
    expect(firstEvent.kind).toBe("approval");
    expect(events.filter((event) => event.type === "ask_user")).toHaveLength(1);

    expect(answerQuestion("conv1", firstEvent.id, "Allow once")).toBe(true);
    expect(await first).toBe("Allow once");

    await Promise.resolve();
    const questions = events.filter((event) => event.type === "ask_user");
    expect(questions).toHaveLength(2);
    const secondEvent = questions[1];
    if (secondEvent?.type !== "ask_user") throw new Error("second prompt was not emitted");
    expect(secondEvent.question).toBe("Allow the second change?");

    expect(answerQuestion("conv1", secondEvent.id, "Deny")).toBe(true);
    expect(await second).toBe("Deny");
  });

  it("removes an aborted prompt while it is waiting in the queue", async () => {
    const events: AgentEvent[] = [];
    const request = createUserInputRequester("conv1", (event) => events.push(event));
    const controller = new AbortController();

    const first = request({ question: "First?", options: [], kind: "question" });
    const queued = request(
      { question: "Never show this", options: ["Allow once", "Deny"], kind: "approval" },
      controller.signal,
    );
    controller.abort();

    expect(await queued).toBeNull();
    expect(events.filter((event) => event.type === "ask_user")).toHaveLength(1);
    const firstEvent = events[0];
    if (firstEvent?.type !== "ask_user") throw new Error("first prompt was not emitted");
    answerQuestion("conv1", firstEvent.id, "done");
    expect(await first).toBe("done");
    expect(events.filter((event) => event.type === "ask_user")).toHaveLength(1);
  });
});
