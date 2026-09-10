import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TranscriptionUploadError,
  createTranscriptionUploadStore,
} from "./transcription-upload.service";

const bytes = (...values: number[]) => new Uint8Array(values);

describe("chunked transcription uploads", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pixelspace-upload-test-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("writes ordered proxy-sized chunks to a temporary recording", async () => {
    const uploads = createTranscriptionUploadStore({ chunkBytes: 4, maxBytes: 20, root });
    const session = await uploads.create("ws1", { title: "meeting.wav", contentType: "audio/wav", size: 10 });

    expect(session).toMatchObject({ chunkBytes: 4, partCount: 3 });
    expect(await uploads.append("ws1", session.uploadId, 0, bytes(1, 2, 3, 4))).toEqual({ receivedBytes: 4, nextPart: 1 });
    expect(await uploads.append("ws1", session.uploadId, 0, bytes(1, 2, 3, 4))).toEqual({ receivedBytes: 4, nextPart: 1 });
    await uploads.append("ws1", session.uploadId, 1, bytes(5, 6, 7, 8));
    await uploads.append("ws1", session.uploadId, 2, bytes(9, 10));

    const completed = await uploads.finish("ws1", session.uploadId);
    expect(completed.title).toBe("meeting.wav");
    expect(completed.contentType).toBe("audio/wav");
    expect(completed.byteLength).toBe(10);
    expect([...await readFile(completed.filePath)]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(uploads.stats()).toEqual({ sessions: 0, reservedBytes: 0 });
    await completed.cleanup();
    expect(Bun.file(completed.filePath).size).toBe(0);
  });

  it("fails closed across workspaces and on missing or out-of-order parts", async () => {
    const uploads = createTranscriptionUploadStore({ chunkBytes: 4, maxBytes: 20, root });
    const session = await uploads.create("alice", { title: "private.mp3", contentType: "audio/mpeg", size: 5 });

    await expect(uploads.append("bob", session.uploadId, 0, bytes(1, 2, 3, 4))).rejects.toThrow("not found");
    await expect(uploads.append("alice", session.uploadId, 1, bytes(1))).rejects.toThrow("Expected upload part 0");
    await expect(uploads.append("alice", session.uploadId, 0, bytes(1, 2))).rejects.toThrow("expected 4");
    await uploads.append("alice", session.uploadId, 0, bytes(1, 2, 3, 4));
    await expect(uploads.append("alice", session.uploadId, 0, bytes(4, 3, 2, 1))).rejects.toThrow("does not match");
    await expect(uploads.finish("alice", session.uploadId)).rejects.toThrow("incomplete");
  });

  it("rejects oversized recordings before any audio is transferred", async () => {
    const uploads = createTranscriptionUploadStore({ chunkBytes: 4, maxBytes: 8, root });

    try {
      await uploads.create("ws1", { title: "huge.wav", contentType: "audio/wav", size: 9 });
      throw new Error("expected create to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(TranscriptionUploadError);
      expect((error as TranscriptionUploadError).status).toBe(413);
    }
    expect(uploads.stats()).toEqual({ sessions: 0, reservedBytes: 0 });
  });

  it("releases reservations on cancellation and expiry", async () => {
    let time = 1_000;
    const uploads = createTranscriptionUploadStore({
      chunkBytes: 4,
      maxBytes: 20,
      maxReservedBytes: 10,
      ttlMs: 50,
      now: () => time,
      root,
    });
    const cancelled = await uploads.create("ws1", { title: "cancel.wav", contentType: "audio/wav", size: 6 });
    await uploads.cancel("ws1", cancelled.uploadId);
    expect(uploads.stats()).toEqual({ sessions: 0, reservedBytes: 0 });

    await uploads.create("ws1", { title: "stale.wav", contentType: "audio/wav", size: 8 });
    await expect(uploads.create("ws1", { title: "blocked.wav", contentType: "audio/wav", size: 3 })).rejects.toThrow("already in progress");
    time += 51;
    await uploads.create("ws1", { title: "fresh.wav", contentType: "audio/wav", size: 3 });
    expect(uploads.stats()).toEqual({ sessions: 1, reservedBytes: 3 });
  });
});
