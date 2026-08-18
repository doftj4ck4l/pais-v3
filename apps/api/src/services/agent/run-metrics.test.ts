import { describe, expect, test } from "bun:test";
import { runMetrics } from "./run-metrics";
import { TranscriptRecorder } from "./transcript.service";

describe("runMetrics", () => {
  test("sums provider input counts across every turn in a run", () => {
    const recorder = new TranscriptRecorder();
    recorder.record({
      type: "trace",
      step: "context.usage",
      fields: { used: 120, output: 15 },
    });
    recorder.record({
      type: "trace",
      step: "context.usage",
      fields: { used: 180, output: 25 },
    });
    recorder.record({
      type: "trace",
      step: "run.tools",
      fields: { toolCalls: 7, toolErrors: 2 },
    });

    expect(runMetrics(recorder.toTraceRows())).toEqual({
      tokensIn: 300,
      tokensOut: 40,
      toolCalls: 7,
      toolErrors: 2,
    });
  });
});
