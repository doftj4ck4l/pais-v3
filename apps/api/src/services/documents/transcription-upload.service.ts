import { mkdir, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Browser-to-API upload sessions for recordings that are too large for one
 * proxy request. Requests stay below 1 MiB and are appended to a temporary
 * file, so accepting a multi-gigabyte recording does not pin it in API memory.
 */

export const TRANSCRIPTION_CHUNK_BYTES = 768 * 1024;
export const MAX_TRANSCRIPTION_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_RESERVED_BYTES = 4 * 1024 * 1024 * 1024;
const SESSION_TTL_MS = 60 * 60 * 1000;

type UploadSession = {
  id: string;
  workspaceId: string;
  title: string;
  contentType: string;
  size: number;
  partCount: number;
  nextPart: number;
  receivedBytes: number;
  filePath: string;
  lastPart: Uint8Array | null;
  writing: boolean;
  updatedAt: number;
};

export type TranscriptionUpload = {
  uploadId: string;
  chunkBytes: number;
  partCount: number;
};

export type CompletedTranscriptionUpload = {
  title: string;
  contentType: string;
  filePath: string;
  byteLength: number;
  cleanup: () => Promise<void>;
};

export class TranscriptionUploadError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 413 | 429) {
    super(message);
    this.name = "TranscriptionUploadError";
  }
}

const uploadId = () =>
  `trup_${Date.now().toString(36)}${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;

const sameBytes = (left: Uint8Array | null, right: Uint8Array) =>
  left?.byteLength === right.byteLength && left.every((value, index) => value === right[index]);

export function createTranscriptionUploadStore(
  options: {
    chunkBytes?: number;
    maxBytes?: number;
    maxReservedBytes?: number;
    ttlMs?: number;
    now?: () => number;
    root?: string;
  } = {},
) {
  const chunkBytes = options.chunkBytes ?? TRANSCRIPTION_CHUNK_BYTES;
  const maxBytes = options.maxBytes ?? MAX_TRANSCRIPTION_BYTES;
  const maxReservedBytes = options.maxReservedBytes ?? MAX_RESERVED_BYTES;
  const ttlMs = options.ttlMs ?? SESSION_TTL_MS;
  const now = options.now ?? Date.now;
  const root = options.root ?? join(tmpdir(), "pixelspace-transcription-uploads", String(process.pid));
  const sessions = new Map<string, UploadSession>();
  let reservedBytes = 0;

  const discard = (session: UploadSession) => {
    if (!sessions.delete(session.id)) return false;
    reservedBytes -= session.size;
    return true;
  };

  const deleteSession = async (session: UploadSession) => {
    if (!discard(session)) return;
    await rm(session.filePath, { force: true });
  };

  const sweep = async () => {
    const cutoff = now() - ttlMs;
    const expired = [...sessions.values()].filter(
      (session) => !session.writing && session.updatedAt < cutoff,
    );
    await Promise.all(expired.map(deleteSession));
  };

  const owned = async (workspaceId: string, id: string) => {
    await sweep();
    const session = sessions.get(id);
    if (!session || session.workspaceId !== workspaceId) {
      throw new TranscriptionUploadError("Upload session not found", 404);
    }
    return session;
  };

  return {
    async create(
      workspaceId: string,
      input: { title: string; contentType: string; size: number },
    ): Promise<TranscriptionUpload> {
      await sweep();
      const title = input.title.trim().replace(/[\\/]/g, "_").slice(0, 255);
      if (!title) throw new TranscriptionUploadError("A recording name is required", 400);
      if (!Number.isSafeInteger(input.size) || input.size <= 0) {
        throw new TranscriptionUploadError("Recording size must be a positive integer", 400);
      }
      if (input.size > maxBytes) {
        throw new TranscriptionUploadError(
          `file is ${(input.size / 1e6).toFixed(1)}MB, over the ${Math.floor(maxBytes / 1024 / 1024)}MiB limit`,
          413,
        );
      }
      if (reservedBytes + input.size > maxReservedBytes) {
        throw new TranscriptionUploadError("too many recording uploads are already in progress", 429);
      }

      const id = uploadId();
      const filePath = join(root, id);
      await mkdir(root, { recursive: true });
      const file = await open(filePath, "wx");
      await file.close();

      const partCount = Math.ceil(input.size / chunkBytes);
      sessions.set(id, {
        id,
        workspaceId,
        title,
        contentType: input.contentType.slice(0, 120) || "application/octet-stream",
        size: input.size,
        partCount,
        nextPart: 0,
        receivedBytes: 0,
        filePath,
        lastPart: null,
        writing: false,
        updatedAt: now(),
      });
      reservedBytes += input.size;
      return { uploadId: id, chunkBytes, partCount };
    },

    async append(workspaceId: string, id: string, part: number, bytes: Uint8Array) {
      const session = await owned(workspaceId, id);
      // A proxy may deliver the bytes and lose only the response. Accept an
      // exact retry of the most recent part so the browser need not restart a
      // large upload; different bytes at that index still fail closed.
      if (part === session.nextPart - 1) {
        if (sameBytes(session.lastPart, bytes)) {
          session.updatedAt = now();
          return { receivedBytes: session.receivedBytes, nextPart: session.nextPart };
        }
        throw new TranscriptionUploadError(`Upload part ${part} does not match the received part`, 409);
      }
      if (session.writing || !Number.isSafeInteger(part) || part !== session.nextPart) {
        throw new TranscriptionUploadError(`Expected upload part ${session.nextPart}`, 409);
      }
      const expected = Math.min(chunkBytes, session.size - session.receivedBytes);
      if (bytes.byteLength !== expected) {
        throw new TranscriptionUploadError(
          `Upload part ${part} is ${bytes.byteLength} bytes; expected ${expected}`,
          bytes.byteLength > chunkBytes ? 413 : 400,
        );
      }

      session.writing = true;
      let file: Awaited<ReturnType<typeof open>> | undefined;
      try {
        file = await open(session.filePath, "r+");
        let written = 0;
        while (written < bytes.byteLength) {
          const result = await file.write(
            bytes,
            written,
            bytes.byteLength - written,
            session.receivedBytes + written,
          );
          if (result.bytesWritten === 0) throw new Error("Could not write the upload chunk");
          written += result.bytesWritten;
        }
        session.lastPart = bytes.slice();
        session.nextPart += 1;
        session.receivedBytes += bytes.byteLength;
        session.updatedAt = now();
      } catch (error) {
        await file?.truncate(session.receivedBytes);
        throw error;
      } finally {
        await file?.close();
        session.writing = false;
      }
      return { receivedBytes: session.receivedBytes, nextPart: session.nextPart };
    },

    async finish(workspaceId: string, id: string): Promise<CompletedTranscriptionUpload> {
      const session = await owned(workspaceId, id);
      if (session.writing || session.receivedBytes !== session.size || session.nextPart !== session.partCount) {
        throw new TranscriptionUploadError(
          `Upload is incomplete (${session.receivedBytes} of ${session.size} bytes received)`,
          409,
        );
      }

      discard(session);
      return {
        title: session.title,
        contentType: session.contentType,
        filePath: session.filePath,
        byteLength: session.size,
        cleanup: () => rm(session.filePath, { force: true }),
      };
    },

    async cancel(workspaceId: string, id: string): Promise<boolean> {
      const session = await owned(workspaceId, id);
      if (session.writing) {
        throw new TranscriptionUploadError("An upload part is still being written", 409);
      }
      await deleteSession(session);
      return true;
    },

    /** Test/operations visibility without exposing recording bytes or paths. */
    stats: () => ({ sessions: sessions.size, reservedBytes }),
  };
}

export type TranscriptionUploadStore = ReturnType<typeof createTranscriptionUploadStore>;
export const transcriptionUploadStore = createTranscriptionUploadStore();
