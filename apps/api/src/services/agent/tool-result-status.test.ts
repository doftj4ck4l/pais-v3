import { describe, expect, it } from "bun:test";
import { isSemanticToolFailure, promoteSemanticToolFailures } from "./tool-result-status";

describe("isSemanticToolFailure", () => {
  it("recognises the error contracts used by app-owned tools", () => {
    expect(isSemanticToolFailure("read_image", "error: model unavailable")).toBe(true);
    expect(isSemanticToolFailure("call_skill", 'skill "web-fetch" exited 1\nHTTP 403')).toBe(true);
    expect(isSemanticToolFailure("call_skill", 'error running skill "docx": timed out')).toBe(true);
    expect(isSemanticToolFailure("render_ui", "render_ui rejected this table:\n- bad props")).toBe(true);
  });

  it("does not mistake successful ordinary text for a failure", () => {
    expect(isSemanticToolFailure("fetch_url", "Title: Error handling\n\nAn article.")).toBe(false);
    expect(isSemanticToolFailure("calendar__list_events", "No events found.")).toBe(false);
  });

  it("leaves echo output opaque even when it starts with the error marker", () => {
    expect(isSemanticToolFailure("echo", "error: this is the requested text")).toBe(false);
  });
});

describe("promoteSemanticToolFailures", () => {
  it("turns an app-owned text error into a rejected execution", async () => {
    const tool = promoteSemanticToolFailures({
      name: "read_image",
      execute: async () => ({ content: [{ type: "text", text: "error: model unavailable" }] }),
    });

    await expect(tool.execute()).rejects.toThrow("error: model unavailable");
  });

  it("passes successful results through unchanged", async () => {
    const result = { content: [{ type: "text", text: "readable article" }] };
    const tool = promoteSemanticToolFailures({
      name: "fetch_url",
      execute: async () => result,
    });

    expect(await tool.execute()).toBe(result);
  });
});
