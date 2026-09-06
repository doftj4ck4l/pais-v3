import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applySchema } from "../../db/client";
import { SqliteDocumentStore } from "../../repositories/document.repository";
import { searchDocuments } from "./search.service";
import { formatTranscript, stamp, transcribeAudio, transcribeToDocs } from "./transcribe.service";

const AUDIO = new Uint8Array([0, 1, 2, 3]);
const INPUT = { bytes: AUDIO, contentType: "audio/mpeg", filename: "call.mp3" };
const CREDS = { apiKey: "k", baseUrl: "http://gw/v1" };

const reply = (json: any) => new Response(JSON.stringify(json), { status: 200 });

describe("transcribeAudio", () => {
  it("returns whisper's timestamped segments", async () => {
    const result = await transcribeAudio(INPUT, {
      ...CREDS,
      fetchImpl: (async () =>
        reply({
          text: " hello world",
          language: "en",
          segments: [
            { start: 0.9, text: "hello" },
            { start: 2.4, text: "world" },
          ],
        })) as any,
    });
    expect(result).toEqual({
      ok: true,
      model: "whisper-1",
      language: "en",
      segments: [
        { start: 0.9, text: "hello" },
        { start: 2.4, text: "world" },
      ],
    });
  });

  it("reads segments nested under audio (faster-whisper-server)", async () => {
    const result = await transcribeAudio(INPUT, {
      ...CREDS,
      fetchImpl: (async () => reply({ text: "x", audio: { segments: [{ start: 5, text: "x" }] } })) as any,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.segments).toEqual([{ start: 5, text: "x" }]);
  });

  it("keeps a plain transcript when the server has no timestamps", async () => {
    const result = await transcribeAudio(INPUT, {
      ...CREDS,
      fetchImpl: (async () => reply({ text: "two lines\nof speech" })) as any,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.segments).toEqual([
      { start: 0, text: "two lines" },
      { start: 0, text: "of speech" },
    ]);
  });

  it("sends model, the audio file and verbose_json, and lets fetch set the boundary", async () => {
    let init: RequestInit | undefined;
    await transcribeAudio(INPUT, {
      ...CREDS,
      fetchImpl: (async (_url: unknown, reqInit: RequestInit) => {
        init = reqInit;
        return reply({ text: "ok", segments: [{ start: 0, text: "ok" }] });
      }) as any,
    });

    expect((init?.headers as Record<string, string>)?.["Content-Type"]).toBeUndefined();
    const form = init?.body as FormData;
    expect(form.get("model")).toBe("whisper-1");
    expect(form.get("response_format")).toBe("verbose_json");
    const file = form.get("file") as File;
    expect(file.name).toBe("call.mp3");
  });

  it("surfaces the whisper server's own refusal, which names the fix", async () => {
    const result = await transcribeAudio(INPUT, {
      ...CREDS,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: { message: "model whisper-1 is not deployed" } }), {
          status: 400,
        })) as any,
    });
    expect(result.ok).toBe(false);
    expect((result as any).error).toContain("not deployed");
  });

  it("reports an empty answer rather than returning empty segments", async () => {
    const result = await transcribeAudio(INPUT, {
      ...CREDS,
      fetchImpl: (async () => reply({ text: "" })) as any,
    });
    expect(result.ok).toBe(false);
    expect((result as any).error).toContain("empty");
  });

  it("survives a non-JSON response", async () => {
    const result = await transcribeAudio(INPUT, {
      ...CREDS,
      fetchImpl: (async () => new Response("<html>502</html>", { status: 200 })) as any,
    });
    expect(result.ok).toBe(false);
    expect((result as any).error).toContain("not JSON");
  });

  it("survives the request throwing", async () => {
    const result = await transcribeAudio(INPUT, {
      ...CREDS,
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as any,
    });
    expect(result.ok).toBe(false);
    expect((result as any).error).toContain("ECONNREFUSED");
  });

  it("says so when nothing is configured", async () => {
    const result = await transcribeAudio(INPUT, { apiKey: "", baseUrl: "" });
    expect(result.ok).toBe(false);
    expect((result as any).error).toContain("no transcription model is configured");
  });
});

describe("stamp / formatTranscript", () => {
  it("stamps mid-run times as MM:SS", () => {
    expect(stamp(0)).toBe("[00:00]");
    expect(stamp(9.7)).toBe("[00:10]");
    expect(stamp(125)).toBe("[02:05]");
    expect(stamp(-3)).toBe("[00:00]");
  });

  it("renders one [MM:SS] line per segment, blank-free for chunk punctuation", () => {
    expect(
      formatTranscript([
        { start: 0, text: "alice speaks" },
        { start: 3, text: "and keeps talking" },
      ]),
    ).toBe("[00:00] alice speaks\n[00:03] and keeps talking");
  });
});

function freshStore() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  applySchema(sqlite);
  return new SqliteDocumentStore(drizzle(sqlite) as any);
}

describe("transcribeToDocs", () => {
  it("indexes the transcript and makes it searchable with a citation", async () => {
    const store = freshStore();
    const res = await transcribeToDocs(
      "ws1",
      "call.mp3",
      INPUT,
      {
        ...CREDS,
        store,
        fetchImpl: (async () =>
          reply({
            text: "quarterly budget",
            segments: [
              { start: 0, text: "the quarterly budget is forty thousand" },
              { start: 5, text: "ship before the end of May" },
            ],
          })) as any,
      },
    );
    expect(res.status).toBe("indexed");
    expect(res.chunks).toBeGreaterThan(0);

    const found = await searchDocuments("ws1", "quarterly budget forty thousand", 5, store);
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.hits[0]!.docTitle).toBe("call.mp3");
    expect(found.hits[0]!.text).toContain("[00:00]");
    expect(found.hits[0]!.text).toContain("quarterly budget");
  });

  it("keeps each workspace's transcripts separate", async () => {
    const store = freshStore();
    await transcribeToDocs("ws_alice", "alice.mp3", INPUT, {
      ...CREDS,
      store,
      fetchImpl: (async () => reply({ text: "alice's secret figures", segments: [{ start: 0, text: "secret figures" }] })) as any,
    });
    await transcribeToDocs("ws_bob", "bob.mp3", INPUT, {
      ...CREDS,
      store,
      fetchImpl: (async () => reply({ text: "bob's unrelated notes", segments: [{ start: 0, text: "unrelated notes" }] })) as any,
    });

    const asBob = await searchDocuments("ws_bob", "secret figures", 5, store);
    expect(asBob.ok).toBe(true);
    if (!asBob.ok) return;
    expect(asBob.hits.every((h) => h.docTitle === "bob.mp3")).toBe(true);
  });

  it("records a transcription failure as an error document, not a crash", async () => {
    const store = freshStore();
    const res = await transcribeToDocs("ws1", "call.mp3", INPUT, {
      ...CREDS,
      store,
      fetchImpl: (async () => new Response("no", { status: 500 })) as any,
    });
    expect(res.status).toBe("error");
    expect(res.chunks).toBe(0);
    const listed = await store.list("ws1");
    expect(listed).toHaveLength(1);
    expect(listed[0]!.status).toBe("error");
    expect(listed[0]!.error).toBeTruthy();
  });
});
