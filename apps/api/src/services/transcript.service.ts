import type { AgentEvent } from "../types/agent";
import type { ChatMessage } from "../types/chat";

/**
 * One entry in a stored transcript. Mirrors the shape the console renders, so a
 * reloaded conversation looks exactly like the live one did.
 */
export type TranscriptItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "iteration"; n: number }
  | {
      kind: "tool";
      /** The call id, used to pair the result. Not serialized into the row. */
      id?: string;
      name: string;
      args: unknown;
      result?: string;
      ms?: number;
      ok?: boolean;
    };

/**
 * One recorded span.
 *
 * `ts` is stamped here, as the event arrives, not when the batch is flushed.
 * The two used to be the same moment — every trace in a run carried the flush
 * timestamp — which collapsed the whole run onto one instant and made a
 * timeline impossible to draw.
 */
export type RecordedTrace = {
  step: string;
  fields: Record<string, unknown>;
  /** When the span ended, epoch ms. */
  ts: number;
  /** Span length; 0 for instantaneous events. Start is `ts - durationMs`. */
  durationMs: number;
};

/**
 * Folds the agent's event stream into a transcript worth saving.
 *
 * The stream is deltas — hundreds of `text` frames per answer — so text is
 * accumulated into a single item here rather than written per frame. Nothing
 * touches the database until the run finishes.
 */
export class TranscriptRecorder {
  private items: TranscriptItem[] = [];
  private traces: RecordedTrace[] = [];
  /**
   * The agent loop reports failures as an `error` event rather than throwing,
   * so the only way to know a run failed is to watch the stream for one.
   */
  private failure: string | null = null;
  /** Index of the item currently receiving deltas, per channel. */
  private open: { thinking: number | null; text: number | null } = {
    thinking: null,
    text: null,
  };

  /**
   * `seqOffset` is where this run's rows start in the stored transcript. A first
   * run starts at 0; a follow-up starts after everything already written, so
   * appended rows extend the conversation instead of colliding with it.
   */
  constructor(
    history: ChatMessage[] = [],
    private readonly seqOffset = 0,
  ) {
    for (const message of history) {
      if (message.role === "user" && message.content) {
        this.items.push({ kind: "user", text: message.content });
      }
    }
  }

  /** The task this run is named after — the first thing the user asked. */
  title(fallback = "Untitled run"): string {
    const first = this.items.find((i) => i.kind === "user");
    if (!first || first.kind !== "user") return fallback;
    return first.text.slice(0, 200) || fallback;
  }

  record(event: AgentEvent): void {
    switch (event.type) {
      case "iteration":
        this.open = { thinking: null, text: null };
        this.items.push({ kind: "iteration", n: event.iteration });
        break;

      case "reasoning":
        this.appendDelta("thinking", event.delta);
        break;

      case "text":
        this.appendDelta("text", event.delta);
        break;

      case "tool_call":
        this.open = { thinking: null, text: null };
        this.items.push({ kind: "tool", id: event.id, name: event.name, args: event.args });
        break;

      case "tool_result": {
        // Pair on the call id. Matching on tool name and "earliest unanswered"
        // is request order, but results arrive in completion order: six
        // parallel `nc_webdav_list_directory` calls came back permuted, each
        // row holding another call's listing under its own arguments. Nothing
        // downstream could detect that — every field was individually valid.
        //
        // The name-ordered walk stays as the fallback for a result with no id,
        // which is the only shape a replayed pre-fix transcript has.
        const idx = this.items.findIndex((i) =>
          i.kind !== "tool" || i.result !== undefined
            ? false
            : event.id !== undefined
              ? i.id === event.id
              : i.name === event.name,
        );
        const pending = idx >= 0 ? this.items[idx] : undefined;
        if (pending && pending.kind === "tool") {
          pending.result = event.content;
          // Kept on the row so a reloaded transcript still shows what each call
          // cost; the matching trace is the queryable copy.
          pending.ms = event.ms;
          pending.ok = event.ok;
        }
        break;
      }

      case "trace": {
        // `ms` is the convention every span already uses for its duration, so
        // it is lifted onto the row rather than left for the reader to dig out
        // of the JSON on every timeline render.
        const ms = Number((event.fields as { ms?: unknown } | undefined)?.ms ?? 0);
        this.traces.push({
          step: event.step,
          fields: event.fields,
          ts: Date.now(),
          durationMs: Number.isFinite(ms) && ms > 0 ? Math.round(ms) : 0,
        });
        break;
      }

      case "error":
        this.failure = event.message;
        break;
    }
  }

  /** The error this run reported, if any. */
  error(): string | null {
    return this.failure;
  }

  /**
   * Did the agent actually do anything? A run can finish without the runtime
   * reporting a failure and still have produced nothing — an unreachable
   * gateway or an unknown model name both surface that way. Such a run is not
   * a success, so the caller needs to be able to tell.
   */
  producedOutput(): boolean {
    return this.items.some(
      (i) => i.kind === "tool" || (i.kind === "assistant" && i.text.trim() !== ""),
    );
  }

  private appendDelta(channel: "thinking" | "text", delta: string): void {
    const kind = channel === "thinking" ? "thinking" : "assistant";
    const idx = this.open[channel];
    const current = idx != null ? this.items[idx] : undefined;

    if (current && current.kind === kind) {
      current.text += delta;
      return;
    }
    this.items.push({ kind, text: delta } as TranscriptItem);
    this.open[channel] = this.items.length - 1;
  }

  /** Rows ready for the messages table. Empty assistant turns are dropped. */
  toMessageRows(): { kind: string; seq: number; text: string }[] {
    return this.items
      .filter((i) => i.kind !== "assistant" || i.text.trim() !== "")
      .map((item, i) => ({ kind: item.kind, seq: this.seqOffset + i, text: serialize(item) }));
  }

  toTraceRows(): RecordedTrace[] {
    return this.traces;
  }
}

function serialize(item: TranscriptItem): string {
  if (item.kind === "iteration") return String(item.n);
  if (item.kind === "tool") {
    return JSON.stringify({
      name: item.name,
      args: item.args,
      result: item.result,
      ms: item.ms,
      ok: item.ok,
    });
  }
  return item.text;
}
