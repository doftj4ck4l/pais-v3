import { describe, expect, it } from "bun:test";
import { extractJsonArray, fingerprint, isDemoted, parseDeltas, scoreOf } from "./delta";
import { MAX_BULLET_CHARS, MAX_DELTAS_PER_RUN } from "./types";

const known = new Set(["pb_a", "pb_b"]);

describe("extractJsonArray", () => {
  it("parses a bare array", () => {
    expect(extractJsonArray('[{"op":"helpful","id":"pb_a"}]')).toHaveLength(1);
  });

  it("parses a fenced array, which is what a model usually returns anyway", () => {
    expect(extractJsonArray('```json\n[{"op":"helpful","id":"pb_a"}]\n```')).toHaveLength(1);
  });

  it("parses an array buried in prose", () => {
    const text = 'Here is what I learned:\n[{"op":"helpful","id":"pb_a"}]\nHope that helps!';
    expect(extractJsonArray(text)).toHaveLength(1);
  });

  it("returns null rather than throwing on garbage", () => {
    expect(extractJsonArray("I could not do that.")).toBeNull();
    expect(extractJsonArray("[not json at all")).toBeNull();
    expect(extractJsonArray("")).toBeNull();
  });

  it("rejects a JSON object that is not an array", () => {
    expect(extractJsonArray('{"op":"helpful"}')).toBeNull();
  });
});

describe("parseDeltas", () => {
  it("accepts the four operations", () => {
    const deltas = parseDeltas(
      [
        { op: "add", kind: "fact", content: "Plane is at https://plane.example" },
        { op: "revise", id: "pb_a", content: "Updated" },
        { op: "helpful", id: "pb_b" },
        { op: "harmful", id: "pb_a" },
      ],
      known,
    );
    expect(deltas.map((d) => d.op)).toEqual(["add", "revise", "helpful", "harmful"]);
  });

  it("drops an operation naming a bullet that does not exist", () => {
    // A hallucinated id is indistinguishable from a real one, and the natural
    // repair — create it — invents playbook entries nobody asked for.
    expect(parseDeltas([{ op: "helpful", id: "pb_invented" }], known)).toEqual([]);
    expect(parseDeltas([{ op: "revise", id: "pb_invented", content: "x" }], known)).toEqual([]);
  });

  it("drops an unknown operation", () => {
    expect(parseDeltas([{ op: "delete", id: "pb_a" }], known)).toEqual([]);
    expect(parseDeltas([{ op: "replace_all", content: "..." }], known)).toEqual([]);
  });

  it("drops an add with an invalid kind", () => {
    expect(parseDeltas([{ op: "add", kind: "opinion", content: "x" }], known)).toEqual([]);
  });

  it("drops an add with no content", () => {
    expect(parseDeltas([{ op: "add", kind: "fact", content: "   " }], known)).toEqual([]);
    expect(parseDeltas([{ op: "add", kind: "fact" }], known)).toEqual([]);
  });

  it("truncates an over-long bullet rather than rejecting it", () => {
    const deltas = parseDeltas([{ op: "add", kind: "fact", content: "x".repeat(1000) }], known);
    expect((deltas[0] as { content: string }).content.length).toBeLessThanOrEqual(MAX_BULLET_CHARS);
  });

  it("flattens newlines, which would otherwise break the rendered list", () => {
    const deltas = parseDeltas(
      [{ op: "add", kind: "fact", content: "line one\n- line two\n\nline three" }],
      known,
    );
    expect((deltas[0] as { content: string }).content).toBe("line one - line two line three");
  });

  it("caps how much one run may change", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      op: "add",
      kind: "fact",
      content: `fact number ${i}`,
    }));
    expect(parseDeltas(many, known)).toHaveLength(MAX_DELTAS_PER_RUN);
  });

  it("survives junk in the array", () => {
    expect(parseDeltas([null, "string", 42, { op: "helpful", id: "pb_a" }], known)).toHaveLength(1);
  });
});

describe("fingerprint", () => {
  it("ignores case and punctuation", () => {
    expect(fingerprint("Plane is at X.")).toBe(fingerprint("plane is at x"));
  });

  it("still distinguishes different claims", () => {
    expect(fingerprint("Plane is at X")).not.toBe(fingerprint("Plane is at Y"));
  });
});

describe("isDemoted", () => {
  it("keeps a bullet with one bad run — coincidence is not evidence", () => {
    expect(isDemoted({ helpful: 0, harmful: 1 })).toBe(false);
  });

  it("demotes a bullet that keeps preceding failures", () => {
    expect(isDemoted({ helpful: 0, harmful: 2 })).toBe(true);
  });

  it("keeps a bullet that is mostly useful despite some bad runs", () => {
    expect(isDemoted({ helpful: 5, harmful: 2 })).toBe(false);
  });
});

describe("scoreOf", () => {
  it("is net value", () => {
    expect(scoreOf({ helpful: 3, harmful: 1 })).toBe(2);
  });
});
