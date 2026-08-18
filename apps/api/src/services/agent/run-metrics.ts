import type { RecordedTrace } from "./transcript.service";

export type RunMetrics = {
  tokensIn: number;
  tokensOut: number;
  toolCalls: number;
  toolErrors: number;
};

export function runMetrics(traces: RecordedTrace[]): RunMetrics {
  let tokensIn = 0;
  let tokensOut = 0;
  let toolCalls = 0;
  let toolErrors = 0;

  for (const trace of traces) {
    if (trace.step === "run.tools") {
      toolCalls = Number(trace.fields.toolCalls ?? 0) || 0;
      toolErrors = Number(trace.fields.toolErrors ?? 0) || 0;
      continue;
    }
    if (trace.step !== "context.usage") continue;
    tokensIn += Number(trace.fields.used ?? 0) || 0;
    tokensOut += Number(trace.fields.output ?? 0) || 0;
  }

  return { tokensIn, tokensOut, toolCalls, toolErrors };
}
