/**
 * Browser-to-API upload sessions for recordings that are too large for one
 * proxy request. Each request stays below 1 MiB, while the completed bytes keep
 * the same in-memory queue contract used by the transcription worker.
 */

export const TRANSCRIPTION_CHUNK_BYTES = 768 * 1024;
export const MAX_TRANSCRIPTION_BYTES = 512 * 1024 * 1024;
const MAX_RESERVED_BYTES = 1024 * 1024 * 1024;
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
  parts: Uint8Array[];
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
  bytes: Uint8Array;
};

export class TranscriptionUploadError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 413 | 429) {
    super(message);
    this.name = "TranscriptionUploadError";
  }
}

const uploadId = () =>
  `trup_${Date.now().toString(36)}${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;

export function createTranscriptionUploadStore(
  options: {
    chunkBytes?: number;
    maxBytes?: number;
    maxReservedBytes?: number;
    ttlMs?: number;
    now?: () => number;
  } = {},
) {
  const chunkBytes = options.chunkBytes ?? TRANSCRIPTION_CHUNK_BYTES;
  const maxBytes = options.maxBytes ?? MAX_TRANSCRIPTION_BYTES;
  const maxReservedBytes = options.maxReservedBytes ?? MAX_RESERVED_BYTES;
  const ttlMs = options.ttlMs ?? SESSION_TTL_MS;
  const now = options.now ?? Date.now;
  const sessions = new Map<string, UploadSession>();
  let reservedBytes = 0;

  const discard = (session: UploadSession) => {
    if (!sessions.delete(session.id)) return;
    reservedBytes -= session.size;
  };

  const sweep = () => {
    const cutoff = now() - ttlMs;
    for (const session of sessions.values()) {
      if (session.updatedAt < cutoff) discard(session);
    }
  };

  const owned = (workspaceId: string, id: string) => {
    sweep();
    const session = sessions.get(id);
    if (!session || session.workspaceId !== workspaceId) {
      throw new TranscriptionUploadError("Upload session not found", 404);
    }
    return session;
  };

  return {
    create(
      workspaceId: string,
      input: { title: string; contentType: string; size: number },
    ): TranscriptionUpload {
      sweep();
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
        parts: [],
        updatedAt: now(),
      });
      reservedBytes += input.size;
      return { uploadId: id, chunkBytes, partCount };
    },

    append(workspaceId: string, id: string, part: number, bytes: Uint8Array) {
      const session = owned(workspaceId, id);
      // A proxy may deliver the bytes and lose only the response. Accept an
      // exact retry of the most recent part so the browser need not restart a
      // large upload; different bytes at that index still fail closed.
      if (part === session.nextPart - 1) {
        const previous = session.parts[part];
        if (previous?.byteLength === bytes.byteLength && previous.every((value, index) => value === bytes[index])) {
          session.updatedAt = now();
          return { receivedBytes: session.receivedBytes, nextPart: session.nextPart };
        }
        throw new TranscriptionUploadError(`Upload part ${part} does not match the received part`, 409);
      }
      if (!Number.isSafeInteger(part) || part !== session.nextPart) {
        throw new TranscriptionUploadError(`Expected upload part ${session.nextPart}`, 409);
      }
      const expected = Math.min(chunkBytes, session.size - session.receivedBytes);
      if (bytes.byteLength !== expected) {
        throw new TranscriptionUploadError(
          `Upload part ${part} is ${bytes.byteLength} bytes; expected ${expected}`,
          bytes.byteLength > chunkBytes ? 413 : 400,
        );
      }

      session.parts.push(bytes.slice());
      session.nextPart += 1;
      session.receivedBytes += bytes.byteLength;
      session.updatedAt = now();
      return { receivedBytes: session.receivedBytes, nextPart: session.nextPart };
    },

    finish(workspaceId: string, id: string): CompletedTranscriptionUpload {
      const session = owned(workspaceId, id);
      if (session.receivedBytes !== session.size || session.nextPart !== session.partCount) {
        throw new TranscriptionUploadError(
          `Upload is incomplete (${session.receivedBytes} of ${session.size} bytes received)`,
          409,
        );
      }

      const bytes = new Uint8Array(session.size);
      let offset = 0;
      for (const part of session.parts) {
        bytes.set(part, offset);
        offset += part.byteLength;
      }
      discard(session);
      return { title: session.title, contentType: session.contentType, bytes };
    },

    cancel(workspaceId: string, id: string): boolean {
      const session = owned(workspaceId, id);
      discard(session);
      return true;
    },

    /** Test/operations visibility without exposing recording bytes. */
    stats: () => ({ sessions: sessions.size, reservedBytes }),
  };
}

export type TranscriptionUploadStore = ReturnType<typeof createTranscriptionUploadStore>;
export const transcriptionUploadStore = createTranscriptionUploadStore();
