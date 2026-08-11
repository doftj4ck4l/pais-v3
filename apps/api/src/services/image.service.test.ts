import { describe, expect, it, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applySchema } from "../db/client";
import { SqliteImageStore } from "../repositories/image.repository";
import { decodeDataUri, generateImage } from "./image.service";

/**
 * A real in-memory database with the production schema, same as the document
 * tests. What is faked here is OpenRouter and the bucket — not SQLite.
 */
function freshStore() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  applySchema(sqlite);
  return new SqliteImageStore(drizzle(sqlite) as any);
}

/** A 1x1 JPEG, small enough to inline and real enough to decode. */
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0xff, 0xd9]);
const JPEG_DATA_URI = `data:image/jpeg;base64,${Buffer.from(JPEG_BYTES).toString("base64")}`;

/** Shape of a real OpenRouter image response, from a recorded live call. */
function openrouterOk(dataUri = JPEG_DATA_URI, cost = 0.0336) {
  return {
    choices: [
      {
        finish_reason: "stop",
        message: {
          role: "assistant",
          // Not a mistake: the real API returns null here and puts the image
          // on `images`. A parser that reads `content` sees nothing.
          content: null,
          images: [{ type: "image_url", image_url: { url: dataUri } }],
        },
      },
    ],
    usage: { cost },
  };
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Captures what was written, standing in for the bucket. */
let puts: { key: string; bytes: Uint8Array; contentType: string }[] = [];
const recordingPut = async (key: string, bytes: Uint8Array, contentType: string) => {
  puts.push({ key, bytes, contentType });
  return key;
};

beforeEach(() => {
  puts = [];
});

describe("decodeDataUri", () => {
  it("decodes the data URI shape OpenRouter actually returns", () => {
    const out = decodeDataUri(JPEG_DATA_URI);
    expect(out?.contentType).toBe("image/jpeg");
    expect(Buffer.from(out!.bytes).equals(Buffer.from(JPEG_BYTES))).toBe(true);
  });

  it("rejects a plain https URL rather than throwing", () => {
    expect(decodeDataUri("https://example.com/a.jpg")).toBeNull();
  });

  it("rejects a data URI whose payload is not valid base64", () => {
    expect(decodeDataUri("data:image/jpeg;base64,!!!not-base64!!!")).toBeNull();
  });
});

describe("generateImage", () => {
  it("stores bytes in the bucket and metadata in the row, and returns only a URL", async () => {
    const store = freshStore();
    const result = await generateImage(
      { workspaceId: "ws1", prompt: "a red circle" },
      { store, putImpl: recordingPut, apiKey: "test-key", fetchImpl: (async () => jsonResponse(openrouterOk())) as any },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.images).toHaveLength(1);

    const img = result.images[0];
    // The whole point of the design: the transcript carries a short URL, never
    // the 30k+ characters of base64 that would blow RESULT_CHAR_CAP.
    expect(img.url).toBe(`/api/images/${img.id}`);
    expect(JSON.stringify(result).length).toBeLessThan(500);
    expect(JSON.stringify(result)).not.toContain("base64");

    const rows = await store.list("ws1");
    expect(rows).toHaveLength(1);
    expect(rows[0].contentType).toBe("image/jpeg");
    expect(rows[0].bytes).toBe(JPEG_BYTES.byteLength);
    expect(rows[0].storageKey).toBe(`ws1/${img.id}.jpg`);
    expect(rows[0].prompt).toBe("a red circle");

    // The bucket got the real decoded bytes under the key the row points at.
    expect(puts).toHaveLength(1);
    expect(puts[0].key).toBe(rows[0].storageKey);
    expect(puts[0].contentType).toBe("image/jpeg");
    expect(Buffer.from(puts[0].bytes).equals(Buffer.from(JPEG_BYTES))).toBe(true);
  });

  it("records cost as integer micro-dollars", async () => {
    const store = freshStore();
    const result = await generateImage(
      { workspaceId: "ws1", prompt: "x" },
      { store, putImpl: recordingPut, apiKey: "test-key", fetchImpl: (async () => jsonResponse(openrouterOk(JPEG_DATA_URI, 0.0336))) as any },
    );
    expect(result.ok).toBe(true);
    const rows = await store.list("ws1");
    expect(rows[0].costMicros).toBe(33_600);
  });

  it("sends modalities so the model returns an image instead of describing one", async () => {
    const store = freshStore();
    let sentBody: any;
    await generateImage(
      { workspaceId: "ws1", prompt: "x" },
      {
        store,
        putImpl: recordingPut, apiKey: "test-key",
        fetchImpl: (async (_url: string, init: any) => {
          sentBody = JSON.parse(init.body);
          return jsonResponse(openrouterOk());
        }) as any,
      },
    );
    expect(sentBody.modalities).toEqual(["image", "text"]);
    // A max_tokens cap is shared with reasoning tokens on these models, and a
    // small one silently yields finish_reason "length" with no image at all.
    expect(sentBody.max_tokens).toBeUndefined();
  });

  it("reports what the model said when it answers with text instead of an image", async () => {
    const store = freshStore();
    const result = await generateImage(
      { workspaceId: "ws1", prompt: "something refused" },
      {
        store,
        putImpl: recordingPut, apiKey: "test-key",
        fetchImpl: (async () =>
          jsonResponse({
            choices: [{ message: { content: "I can't create that image.", images: [] } }],
            usage: { cost: 0 },
          })) as any,
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("I can't create that image.");
    expect(await store.list("ws1")).toHaveLength(0);
  });

  it("surfaces an HTTP failure without writing a row", async () => {
    const store = freshStore();
    const result = await generateImage(
      { workspaceId: "ws1", prompt: "x" },
      { store, putImpl: recordingPut, apiKey: "test-key", fetchImpl: (async () => new Response("no credits", { status: 402 })) as any },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("402");
    expect(await store.list("ws1")).toHaveLength(0);
    expect(puts).toHaveLength(0);
  });

  it("refuses an empty prompt before spending anything", async () => {
    let called = false;
    const result = await generateImage(
      { workspaceId: "ws1", prompt: "   " },
      {
        store: freshStore(),
        putImpl: recordingPut, apiKey: "test-key",
        fetchImpl: (async () => {
          called = true;
          return jsonResponse(openrouterOk());
        }) as any,
      },
    );
    expect(result.ok).toBe(false);
    expect(called).toBe(false);
  });

  it("keeps one workspace's images out of another's listing", async () => {
    const store = freshStore();
    const fetchImpl = (async () => jsonResponse(openrouterOk())) as any;
    const deps = { store, putImpl: recordingPut, apiKey: "test-key", fetchImpl };
    await generateImage({ workspaceId: "ws1", prompt: "a" }, deps);
    await generateImage({ workspaceId: "ws2", prompt: "b" }, deps);

    expect(await store.list("ws1")).toHaveLength(1);
    expect((await store.list("ws1"))[0].prompt).toBe("a");
    expect(await store.list("ws2")).toHaveLength(1);
  });
});
