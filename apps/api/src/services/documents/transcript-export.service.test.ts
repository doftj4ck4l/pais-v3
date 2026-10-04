import { describe, expect, test } from "bun:test";
import { transcriptBlocks } from "./transcript-export.service";

describe("transcript export blocks", () => {
  test("groups segments into 30-second intervals", () => {
    const blocks = transcriptBlocks([
      { start: 0, text: "hello" },
      { start: 5, text: "world" },
      { start: 30, text: "next window" },
      { start: 65, text: "later" },
    ]);

    expect(blocks).toEqual([
      { kind: "heading", level: 3, text: "00:00 – 00:30" },
      { kind: "body", text: "hello world" },
      { kind: "heading", level: 3, text: "00:30 – 01:00" },
      { kind: "body", text: "next window" },
      { kind: "heading", level: 3, text: "01:00 – 01:30" },
      { kind: "body", text: "later" },
    ]);
  });

  test("returns no blocks for an empty transcript", () => {
    expect(transcriptBlocks([])).toEqual([]);
  });
});
