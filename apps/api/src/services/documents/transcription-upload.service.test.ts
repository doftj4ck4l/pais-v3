import { describe, expect, it } from "bun:test";
import {
  TranscriptionUploadError,
  createTranscriptionUploadStore,
} from "./transcription-upload.service";

const bytes = (...values: number[]) => new Uint8Array(values);

describe("chunked transcription uploads", () => {
  it("assembles ordered proxy-sized chunks into the original recording", () => {
    const uploads = createTranscriptionUploadStore({ chunkBytes: 4, maxBytes: 20 });
    const session = uploads.create("ws1", { title: "meeting.wav", contentType: "audio/wav", size: 10 });

    expect(session).toMatchObject({ chunkBytes: 4, partCount: 3 });
    expect(uploads.append("ws1", session.uploadId, 0, bytes(1, 2, 3, 4))).toEqual({ receivedBytes: 4, nextPart: 1 });
    expect(uploads.append("ws1", session.uploadId, 0, bytes(1, 2, 3, 4))).toEqual({ receivedBytes: 4, nextPart: 1 });
    uploads.append("ws1", session.uploadId, 1, bytes(5, 6, 7, 8));
    uploads.append("ws1", session.uploadId, 2, bytes(9, 10));

    const completed = uploads.finish("ws1", session.uploadId);
    expect(completed.title).toBe("meeting.wav");
    expect(completed.contentType).toBe("audio/wav");
    expect([...completed.bytes]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(uploads.stats()).toEqual({ sessions: 0, reservedBytes: 0 });
  });

  it("fails closed across workspaces and on missing or out-of-order parts", () => {
    const uploads = createTranscriptionUploadStore({ chunkBytes: 4, maxBytes: 20 });
    const session = uploads.create("alice", { title: "private.mp3", contentType: "audio/mpeg", size: 5 });

    expect(() => uploads.append("bob", session.uploadId, 0, bytes(1, 2, 3, 4))).toThrow("not found");
    expect(() => uploads.append("alice", session.uploadId, 1, bytes(1))).toThrow("Expected upload part 0");
    expect(() => uploads.append("alice", session.uploadId, 0, bytes(1, 2))).toThrow("expected 4");
    uploads.append("alice", session.uploadId, 0, bytes(1, 2, 3, 4));
    expect(() => uploads.append("alice", session.uploadId, 0, bytes(4, 3, 2, 1))).toThrow("does not match");
    expect(() => uploads.finish("alice", session.uploadId)).toThrow("incomplete");
  });

  it("rejects oversized recordings before any audio is transferred", () => {
    const uploads = createTranscriptionUploadStore({ chunkBytes: 4, maxBytes: 8 });

    try {
      uploads.create("ws1", { title: "huge.wav", contentType: "audio/wav", size: 9 });
      throw new Error("expected create to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(TranscriptionUploadError);
      expect((error as TranscriptionUploadError).status).toBe(413);
    }
    expect(uploads.stats()).toEqual({ sessions: 0, reservedBytes: 0 });
  });

  it("releases reservations on cancellation and expiry", () => {
    let time = 1_000;
    const uploads = createTranscriptionUploadStore({
      chunkBytes: 4,
      maxBytes: 20,
      maxReservedBytes: 10,
      ttlMs: 50,
      now: () => time,
    });
    const cancelled = uploads.create("ws1", { title: "cancel.wav", contentType: "audio/wav", size: 6 });
    uploads.cancel("ws1", cancelled.uploadId);
    expect(uploads.stats()).toEqual({ sessions: 0, reservedBytes: 0 });

    uploads.create("ws1", { title: "stale.wav", contentType: "audio/wav", size: 8 });
    expect(() => uploads.create("ws1", { title: "blocked.wav", contentType: "audio/wav", size: 3 })).toThrow("already in progress");
    time += 51;
    uploads.create("ws1", { title: "fresh.wav", contentType: "audio/wav", size: 3 });
    expect(uploads.stats()).toEqual({ sessions: 1, reservedBytes: 3 });
  });
});
