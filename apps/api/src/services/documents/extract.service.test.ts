import { expect, test } from "bun:test";
import { pathToFileURL } from "node:url";

test("extracts PDFs when the native binding is unavailable", async () => {
  const extractorUrl = pathToFileURL(`${import.meta.dirname}/extract.service.ts`).href;
  const fixtureUrl = pathToFileURL(`${import.meta.dirname}/../testing/make-pdf.ts`).href;
  const script = `
    import { mock } from "bun:test";
    import { makeImageOnlyPdf, makePdf } from ${JSON.stringify(fixtureUrl)};
    mock.module("@firecrawl/pdf-inspector", () => {
      throw new Error("Cannot find native binding");
    });
    const { extractPdf } = await import(${JSON.stringify(extractorUrl)});
    const readable = await extractPdf(makePdf(["Portable extraction works on ARM64."]));
    const mixed = await extractPdf(makePdf(["First page", "", "Third page"]));
    const scanned = await extractPdf(makeImageOnlyPdf(2));
    const unreadable = await extractPdf(new TextEncoder().encode("not a PDF"));
    process.stdout.write(JSON.stringify({ readable, mixed, scanned, unreadable }));
  `;
  const child = Bun.spawnSync([process.execPath, "-e", script], {
    cwd: import.meta.dir,
    env: { ...process.env, AUTH_MODE: "proxy" },
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(child.exitCode).toBe(0);
  expect(JSON.parse(child.stdout.toString())).toEqual({
    readable: {
      ok: true,
      pages: [{ page: 1, text: "Portable extraction works on ARM64." }],
      pageCount: 1,
    },
    mixed: {
      ok: true,
      pages: [
        { page: 1, text: "First page" },
        { page: 3, text: "Third page" },
      ],
      pageCount: 3,
      note: "1 of 3 page(s) had no usable text and were skipped (pages 2) — they need OCR",
    },
    scanned: {
      ok: false,
      reason: "no-text",
      pageCount: 2,
      message:
        "no usable text layer across 2 page(s) (no text layer) — this is usually a scanned PDF, which needs OCR before it can be indexed",
    },
    unreadable: {
      ok: false,
      reason: "unreadable",
      pageCount: 0,
      message: expect.stringContaining("could not parse the PDF"),
    },
  });
});
