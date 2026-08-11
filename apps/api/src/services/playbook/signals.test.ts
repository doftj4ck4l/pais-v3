import { describe, expect, it } from "bun:test";
import { renderSignals, summariseRun, type ToolCallRecord } from "./signals";

const call = (over: Partial<ToolCallRecord> = {}): ToolCallRecord => ({
  name: "search_tools",
  ok: true,
  args: '{"query":"a"}',
  resultChars: 100,
  ...over,
});

describe("summariseRun", () => {
  it("reports an empty run as empty", () => {
    expect(summariseRun([]).empty).toBe(true);
  });

  it("counts errors and empty results per tool", () => {
    const signals = summariseRun([
      call({ name: "plane__create_work_item", ok: false }),
      call({ name: "plane__create_work_item", resultChars: 0 }),
      call({ name: "plane__create_work_item" }),
    ]);

    const tool = signals.tools[0]!;
    expect(tool.calls).toBe(3);
    expect(tool.errors).toBe(1);
    expect(tool.empty).toBe(1);
  });

  it("counts a byte-identical repeat as waste, not as a distinct attempt", () => {
    const signals = summariseRun([
      call({ args: '{"query":"slug"}' }),
      call({ args: '{"query":"slug"}' }),
    ]);

    expect(signals.tools[0]!.repeats).toBe(1);
    expect(signals.tools[0]!.distinctArgs).toBe(1);
    // Two calls, one distinct argument set: a repeat, not a hunt.
    expect(signals.searching).toEqual([]);
  });

  it("flags the run that motivated this — one tool, many different queries", () => {
    // Six search_tools calls hunting for a workspace-slug tool that does not
    // exist. Each call individually succeeded, which is why per-call checks
    // find nothing wrong with it.
    const signals = summariseRun([
      call({ args: '{"query":"workspace slug"}' }),
      call({ args: '{"query":"workspace"}' }),
      call({ args: '{"query":"get workspace"}' }),
      call({ args: '{"query":"slug url"}' }),
      call({ args: '{"query":"plane url"}' }),
      call({ args: '{"query":"project link"}' }),
    ]);

    expect(signals.searching).toEqual(["search_tools"]);
    expect(signals.tools[0]!.errors).toBe(0);
  });

  it("does not flag two attempts as hunting", () => {
    const signals = summariseRun([call({ args: '{"query":"a"}' }), call({ args: '{"query":"b"}' })]);
    expect(signals.searching).toEqual([]);
  });

  it("orders tools by how often they were called", () => {
    const signals = summariseRun([
      call({ name: "quiet" }),
      call({ name: "loud", args: "1" }),
      call({ name: "loud", args: "2" }),
    ]);
    expect(signals.tools.map((t) => t.name)).toEqual(["loud", "quiet"]);
  });
});

describe("renderSignals", () => {
  it("says so when nothing ran", () => {
    expect(renderSignals(summariseRun([]))).toContain("No tools were called");
  });

  it("names hunting explicitly rather than leaving it to be inferred", () => {
    const text = renderSignals(
      summariseRun([
        call({ args: "1" }),
        call({ args: "2" }),
        call({ args: "3" }),
      ]),
    );
    expect(text).toContain("hunting");
    expect(text).toContain("search_tools ×3");
  });

  it("reports a clean call as clean", () => {
    expect(renderSignals(summariseRun([call({ name: "calculator" })]))).toContain("succeeded cleanly");
  });
});
