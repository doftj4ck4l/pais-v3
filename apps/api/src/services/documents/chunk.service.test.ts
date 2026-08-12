import { describe, expect, it } from "bun:test";
import { chunkPages } from "./chunk.service";

const para = (n: number, word = "alpha") => Array(n).fill(word).join(" ");

describe("chunkPages", () => {
  it("keeps a short page as a single chunk", () => {
    const out = chunkPages([{ page: 1, text: "Refunds are issued within 30 days." }]);
    expect(out).toEqual([{ seq: 0, page: 1, text: "Refunds are issued within 30 days." }]);
  });

  it("drops blank pages instead of emitting empty chunks", () => {
    const out = chunkPages([
      { page: 1, text: "   \n\n  " },
      { page: 2, text: "Real content." },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.page).toBe(2);
  });

  it("never lets a chunk span two pages, so citations stay true", () => {
    const out = chunkPages([
      { page: 1, text: "Page one body." },
      { page: 2, text: "Page two body." },
    ]);
    expect(out.map((c) => c.page)).toEqual([1, 2]);
    expect(out[0]!.text).not.toContain("Page two");
    expect(out[1]!.text).not.toContain("Page one");
  });

  it("numbers chunks continuously across pages", () => {
    const out = chunkPages([
      { page: 1, text: `${para(120)}\n\n${para(120)}` },
      { page: 2, text: "Second page." },
    ]);
    expect(out.map((c) => c.seq)).toEqual(out.map((_, i) => i));
    expect(out.at(-1)!.page).toBe(2);
  });

  it("splits a long page into multiple chunks under the budget", () => {
    const text = Array.from({ length: 8 }, (_, i) => `Paragraph ${i}. ${para(40)}`).join("\n\n");
    const out = chunkPages([{ page: 1, text }], { maxChars: 500, overlap: 0 });
    expect(out.length).toBeGreaterThan(1);
    for (const c of out) expect(c.text.length).toBeLessThanOrEqual(500);
  });

  it("overlaps consecutive chunks so a split passage is findable from either side", () => {
    const text = Array.from({ length: 8 }, (_, i) => `Para${i} ${para(30)}`).join("\n\n");
    const out = chunkPages([{ page: 1, text }], { maxChars: 400, overlap: 80 });
    expect(out.length).toBeGreaterThan(1);
    const carried = out[1]!.text.slice(0, 40);
    expect(out[0]!.text).toContain(carried.trim().split(/\s+/)[0]!);
  });

  it("starts overlap on a word boundary, never mid-word", () => {
    const text = Array.from({ length: 6 }, () => para(40, "supercalifragilistic")).join("\n\n");
    const out = chunkPages([{ page: 1, text }], { maxChars: 500, overlap: 100 });
    for (const c of out.slice(1)) {
      expect(c.text.startsWith("supercalifragilistic")).toBe(true);
    }
  });

  it("hard-splits a single sentence longer than the budget", () => {
    const out = chunkPages([{ page: 1, text: "x".repeat(2500) }], { maxChars: 400, overlap: 0 });
    expect(out.length).toBeGreaterThan(1);
    for (const c of out) expect(c.text.length).toBeLessThanOrEqual(400);
  });

  it("splits an oversized paragraph on sentence boundaries", () => {
    const sentences = Array.from({ length: 10 }, (_, i) => `This is sentence number ${i}.`);
    const out = chunkPages([{ page: 1, text: sentences.join(" ") }], {
      maxChars: 90,
      overlap: 0,
    });
    expect(out.length).toBeGreaterThan(1);
    // No chunk should end mid-sentence.
    for (const c of out) expect(c.text.trim()).toMatch(/\.$/);
  });

  it("normalises ragged PDF whitespace", () => {
    const out = chunkPages([{ page: 3, text: "Line   one\r\n\r\n\r\n\r\nLine    two" }]);
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe("Line one\n\nLine two");
    expect(out[0]!.page).toBe(3);
  });

  it("returns nothing for an entirely empty document", () => {
    expect(chunkPages([])).toEqual([]);
    expect(chunkPages([{ page: 1, text: "" }])).toEqual([]);
  });
});
