import { describe, expect, test } from "bun:test";
import { exportChatAnswer, requestedChatExport } from "./chat-export.service";

describe("Chat answer export", () => {
  test("recognises requests to export the existing answer, not arbitrary PDF questions", () => {
    expect(requestedChatExport("Okay, make me a PDF document from this summary")).toBe("pdf");
    expect(requestedChatExport("Jadikan analisis tadi sebagai dokumen Word")).toBe("docx");
    expect(requestedChatExport("What is a PDF document?")).toBeNull();
  });

  test.each(["pdf", "docx"] as const)("renders a real %s file and writes it once", async (format) => {
    let written: Uint8Array | undefined;
    const result = await exportChatAnswer({
      workspaceId: "ws-1",
      content: "# Summary\n\n- First finding\n- Second finding\n\nMalay: keputusan",
      format,
      now: new Date("2026-09-21T12:00:00.000Z"),
      write: async (_workspaceId, _path, bytes) => {
        written = bytes;
      },
      urlFor: (_workspaceId, path) => `/download/${path}`,
    });

    expect(result.path).toBe(`chat-export-2026-09-21T12-00-00-000Z.${format}`);
    expect(result.url).toBe(`/download/${result.path}`);
    expect(written?.byteLength).toBeGreaterThan(500);
    const signature = new TextDecoder().decode(written!.slice(0, 4));
    expect(signature.startsWith(format === "pdf" ? "%PDF" : "PK")).toBe(true);
  });
});
