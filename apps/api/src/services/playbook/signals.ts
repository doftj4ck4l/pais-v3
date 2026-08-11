/**
 * What the run's tool calls say about how well it went, computed in code.
 *
 * The published work this follows gets its helpful/harmful signal free, because
 * its benchmark runs code and code either passes or throws. A chat turn has no
 * such oracle, and asking the reflector to judge its own transcript is asking
 * the same model that just failed whether it failed.
 *
 * So the judgment is made here instead, from spans that were already being
 * recorded, and handed to the reflector as fact rather than as a question. The
 * three detections below are each a specific observed failure:
 *
 * - `errors`     a tool that returned isError. Unambiguous.
 * - `repeats`    the same tool called twice with byte-identical arguments. The
 *                second call cannot have learned anything the first did not.
 * - `searching`  three or more calls to one tool with *different* arguments in
 *                a single run. This is the shape of the run that prompted all
 *                of this: six `search_tools` calls hunting for a tool that did
 *                not exist. Nothing about any individual call is wrong, which
 *                is exactly why the per-call checks miss it.
 */

/** One tool call as the run observed it. Mirrors the `tool` trace span. */
export type ToolCallRecord = {
  name: string;
  ok: boolean;
  /** Truncated JSON of the arguments, as the span records them. */
  args: string;
  resultChars: number;
};

export type ToolSignal = {
  name: string;
  calls: number;
  errors: number;
  /** Calls whose result was empty. A search that found nothing looks like this. */
  empty: number;
  /** Calls that repeated an earlier call's exact arguments. */
  repeats: number;
  /** Distinct argument sets seen. */
  distinctArgs: number;
};

export type RunSignals = {
  tools: ToolSignal[];
  /** Tools that look like they were hunting rather than acting. */
  searching: string[];
  /** True when nothing at all is worth reflecting on. */
  empty: boolean;
};

/**
 * Calls to one tool, with distinct arguments, above which the run reads as a
 * search rather than as work. Two is a retry with a fix; three is a hunt.
 */
const SEARCH_THRESHOLD = 3;

export function summariseRun(calls: ToolCallRecord[]): RunSignals {
  const byName = new Map<string, ToolSignal>();
  const seenArgs = new Map<string, Set<string>>();

  for (const call of calls) {
    let signal = byName.get(call.name);
    if (!signal) {
      signal = { name: call.name, calls: 0, errors: 0, empty: 0, repeats: 0, distinctArgs: 0 };
      byName.set(call.name, signal);
      seenArgs.set(call.name, new Set());
    }
    const args = seenArgs.get(call.name)!;

    signal.calls++;
    if (!call.ok) signal.errors++;
    if (call.resultChars === 0) signal.empty++;
    if (args.has(call.args)) signal.repeats++;
    else args.add(call.args);
    signal.distinctArgs = args.size;
  }

  const tools = [...byName.values()].sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
  const searching = tools
    .filter((t) => t.distinctArgs >= SEARCH_THRESHOLD)
    .map((t) => t.name);

  return { tools, searching, empty: tools.length === 0 };
}

/**
 * The signals as a block the reflector reads.
 *
 * Prose rather than JSON because it is being handed to a model, and because
 * the interesting part is the interpretation ("hunting", "wasted") rather than
 * the counts. The counts are there to be quoted back into a bullet.
 */
export function renderSignals(signals: RunSignals): string {
  if (signals.empty) return "No tools were called during this run.";

  const lines = signals.tools.map((t) => {
    const notes: string[] = [];
    if (t.errors) notes.push(`${t.errors} failed`);
    if (t.empty) notes.push(`${t.empty} returned nothing`);
    if (t.repeats) notes.push(`${t.repeats} repeated an earlier call exactly — wasted`);
    if (t.distinctArgs >= SEARCH_THRESHOLD) {
      notes.push(`${t.distinctArgs} different attempts — this looks like hunting, not working`);
    }
    if (!notes.length) notes.push("succeeded cleanly");
    return `- ${t.name} ×${t.calls}: ${notes.join("; ")}`;
  });

  return `Tool activity this run:\n${lines.join("\n")}`;
}
