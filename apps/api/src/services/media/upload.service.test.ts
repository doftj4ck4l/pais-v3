import { beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applySchema } from "../../db/client";
import { SqliteImageStore } from "../../repositories/image.repository";
import { describeAttachments, storeUploadedImage } from "./upload.service";

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

let sqlite: Database;
let store: SqliteImageStore;
let put: (key: string, bytes: Uint8Array, contentType: string) => Promise<string>;
let written: { key: string; bytes: number; contentType: string }[];

beforeEach(() => {
  sqlite = new Database(":memory:");
  applySchema(sqlite);
  store = new SqliteImageStore(drizzle(sqlite) as never);
  written = [];
  put = async (key, bytes, contentType) => {
    written.push({ key, bytes: bytes.byteLength, contentType });
    return key;
  };
});

const upload = (over: Partial<Parameters<typeof storeUploadedImage>[0]> = {}) =>
  storeUploadedImage(
    { workspaceId: "ws1", bytes: png, contentType: "image/png", name: "shot.png", ...over },
    store,
    put as never,
  );

describe("storeUploadedImage", () => {
  it("stores the bytes and returns the URL read_image resolves", async () => {
    const result = await upload();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.url).toBe(`/api/images/${result.id}`);
    expect(written).toHaveLength(1);
    // Workspace-prefixed key, so a bucket listing is scoped like generated images.
    expect(written[0]!.key).toStartWith("ws1/");
    expect(written[0]!.key).toEndWith(".png");
  });

  it("records the row as uploaded, not generated", async () => {
    // Without this the row is a generation whose model happened to be blank,
    // which is how a cost report ends up wrong.
    const result = await upload();
    if (!result.ok) throw new Error("expected ok");
    const row = await store.get(result.id);
    expect(row?.source).toBe("uploaded");
    expect(row?.costMicros).toBeNull();
    expect(row?.model).toBe("");
  });

  it("keeps the filename as a label", async () => {
    const result = await upload({ name: "screenshot 2026.png" });
    if (!result.ok) throw new Error("expected ok");
    expect((await store.get(result.id))?.prompt).toBe("screenshot 2026.png");
  });

  it("normalises a content type carrying a charset", async () => {
    const result = await upload({ contentType: "image/png; charset=binary" });
    expect(result.ok).toBe(true);
  });

  it("refuses SVG, which is a document that can carry script", async () => {
    const result = await upload({ contentType: "image/svg+xml" });
    expect(result.ok).toBe(false);
    expect(written).toHaveLength(0);
  });

  it("refuses a non-image outright", async () => {
    expect((await upload({ contentType: "application/pdf" })).ok).toBe(false);
    expect((await upload({ contentType: "" })).ok).toBe(false);
  });

  it("refuses an empty file", async () => {
    expect((await upload({ bytes: new Uint8Array(0) })).ok).toBe(false);
  });

  it("refuses one past the size cap before writing anything", async () => {
    const result = await upload({ bytes: new Uint8Array(20_000_000) });
    expect(result.ok).toBe(false);
    expect(written).toHaveLength(0);
  });

  it("does not write a row when the bucket write fails", async () => {
    const failing = async () => {
      throw new Error("rustfs down");
    };
    const result = await storeUploadedImage(
      { workspaceId: "ws1", bytes: png, contentType: "image/png" },
      store,
      failing as never,
    );
    expect(result.ok).toBe(false);
    expect(await store.list("ws1")).toHaveLength(0);
  });
});

describe("describeAttachments", () => {
  const idOf = async (workspaceId = "ws1") => {
    const r = await storeUploadedImage(
      { workspaceId, bytes: png, contentType: "image/png" },
      store,
      put as never,
    );
    if (!r.ok) throw new Error("expected ok");
    return r.id;
  };

  it("names the image and tells the model how to look at it", async () => {
    const id = await idOf();
    const note = await describeAttachments("ws1", [id], store);
    expect(note).toContain(`/api/images/${id}`);
    expect(note).toContain("read_image");
    expect(note).toContain("an image");
  });

  it("pluralises for several", async () => {
    const note = await describeAttachments("ws1", [await idOf(), await idOf()], store);
    expect(note).toContain("2 images");
    expect(note).toContain("each source");
  });

  it("drops ids belonging to another workspace, silently", async () => {
    // Naming them back would confirm that an id exists somewhere else.
    const foreign = await idOf("ws_other");
    expect(await describeAttachments("ws1", [foreign], store)).toBe("");
  });

  it("drops ids that do not exist", async () => {
    expect(await describeAttachments("ws1", ["3f9a1c2e-7b41-4d0a-9c33-2e8b17d5a604"], store)).toBe("");
  });

  it("returns nothing for no attachments, so no note is appended", async () => {
    expect(await describeAttachments("ws1", [], store)).toBe("");
  });

  it("caps how many one message may carry", async () => {
    const ids = [];
    for (let i = 0; i < 10; i++) ids.push(await idOf());
    const note = await describeAttachments("ws1", ids, store);
    // Each attachment is a separate vision call the agent may make.
    expect(note).toContain("6 images");
    expect(note.match(/\/api\/images\//g)).toHaveLength(6);
  });
});
