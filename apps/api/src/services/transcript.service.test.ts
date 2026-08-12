import { describe, expect, test } from "bun:test";
import { TranscriptRecorder } from "./transcript.service";

/**
 * Parallel calls to one tool are the case that matters here. The recorder used
 * to pair a result with the earliest *unanswered call of the same name*, which
 * is request order — but results arrive in completion order, so a batch of six
 * `nc_webdav_list_directory` calls came back permuted. Every row looked
 * plausible: real arguments, real content, wrong pairing. 113 of 151 stored NAS
 * tool rows on the deployed database had a result belonging to another call.
 */
describe("TranscriptRecorder tool pairing", () => {
  const call = (id: string, name: string, args: Record<string, unknown>) =>
    ({ type: "tool_call", id, name, args }) as const;
  const result = (id: string, name: string, content: string) =>
    ({ type: "tool_result", id, name, content, calls: 1, ok: true }) as const;

  /** The stored rows, which is what a reloaded conversation is rebuilt from. */
  const pairs = (r: TranscriptRecorder) =>
    r
      .toMessageRows()
      .filter((row) => row.kind === "tool")
      .map((row) => JSON.parse(row.text) as { args: { path?: string }; result?: string })
      .map((t) => [t.args.path, t.result]);

  test("pairs results to calls by id when they complete out of order", () => {
    const r = new TranscriptRecorder();
    r.record(call("c1", "list_directory", { path: "/GEO" }));
    r.record(call("c2", "list_directory", { path: "/TELENAS" }));
    r.record(call("c3", "list_directory", { path: "/MYCIP" }));

    // Completion order is not request order.
    r.record(result("c3", "list_directory", "listing of /MYCIP"));
    r.record(result("c1", "list_directory", "listing of /GEO"));
    r.record(result("c2", "list_directory", "listing of /TELENAS"));

    expect(pairs(r)).toEqual([
      ["/GEO", "listing of /GEO"],
      ["/TELENAS", "listing of /TELENAS"],
      ["/MYCIP", "listing of /MYCIP"],
    ]);
  });

  test("still pairs in order when a result carries no id", () => {
    const r = new TranscriptRecorder();
    r.record(call("c1", "read_file", { path: "/a" }));
    r.record({ type: "tool_result", name: "read_file", content: "A", calls: 1 });

    expect(pairs(r)).toEqual([["/a", "A"]]);
  });

  test("does not attach a result to a call of a different tool", () => {
    const r = new TranscriptRecorder();
    r.record(call("c1", "read_file", { path: "/a" }));
    r.record(result("c9", "search_files", "unrelated"));

    expect(pairs(r)).toEqual([["/a", undefined]]);
  });
});
