import { logger } from "../../lib/logger";
import {
  transcriptionStore,
  type TranscriptionStore,
} from "../../repositories/transcription.repository";
import type { TranscriptionRow } from "../../models/schema";
import { transcribeToCorpus, type CorpusOutcome } from "./transcribe.service";

/**
 * The audio transcription queue.
 *
 * A single upload used to hold the HTTP request open for the whole whisper
 * call, which meant there was no server-visible "in progress": a page could
 * not say where any recording stood, and drop ten files at once and whisper
 * saw a burst of simultaneous calls. Now an upload only enqueues: the request
 * answers 202 the moment the job is recorded, and one in-process worker runs
 * the FIFO queue at a time. The `transcriptions` table says what the page
 * keeps asking, and the story ends the same way runs do — a restart marks
 * everything in flight `failed`, because the audio bytes only ever lived in
 * the process holding them.
 *
 * The worker is deliberately not a separate process: the API is a single Bun
 * runtime, and a whisper call is I/O wait, not CPU. Concurrency is one so a
 * burst of uploads cannot launch a whisper stampede.
 */

export class TranscriptionQueueFullError extends Error {
  constructor() {
    super("the transcription queue is busy — try again in a moment");
    this.name = "TranscriptionQueueFullError";
  }
}

export type TranscriptionJob = {
  id: string;
  workspaceId: string;
  title: string;
  bytes: Uint8Array;
  contentType: string;
  filename: string;
};

/** How one job is transcribed once its turn comes. Injected for tests. */
export type RunTranscription = (job: TranscriptionJob) => Promise<CorpusOutcome>;

/** Upper bound on audio bytes waiting in line, so enqueue cannot pin RAM. */
const MAX_PENDING_BYTES = 2 * 1024 * 1024 * 1024;

const newTranscriptionId = () =>
  `trx_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export function createTranscriber(
  deps: { store?: TranscriptionStore; run?: RunTranscription } = {},
) {
  const store = deps.store ?? transcriptionStore;
  const run = deps.run ?? ((job) => transcribeToCorpus(job.workspaceId, job.title, job, {}));

  const pending: TranscriptionJob[] = [];
  let pendingBytes = 0;
  let running = false;

  const drain = async () => {
    if (running) return;
    running = true;
    try {
      while (pending.length) {
        const job = pending.shift()!;
        pendingBytes -= job.bytes.byteLength;
        await runJob(job);
      }
    } finally {
      running = false;
    }
  };

  const runJob = async (job: TranscriptionJob) => {
    await store.markTranscribing(job.id);
    try {
      const outcome = await run(job);
      if (outcome.ok) {
        await store.markDone(job.id, outcome.documentId, outcome.model);
        logger.info("transcribe.job.done", {
          transcriptionId: job.id,
          title: job.title,
          model: outcome.model,
          chunks: outcome.chunks,
          ms: 0,
        });
      } else {
        await store.markFailed(job.id, outcome.error);
        logger.warn("transcribe.job.failed", {
          transcriptionId: job.id,
          title: job.title,
          error: outcome.error,
        });
      }
    } catch (e: any) {
      await store.markFailed(job.id, String(e?.message ?? e).slice(0, 300));
      logger.error("transcribe.job.error", { transcriptionId: job.id, message: String(e?.message ?? e) });
    }
  };

  return {
    pendingCount: () => pending.length,

    /** Record the job and start working it. Resolves once it is safe in line. */
    async enqueue(
      input: { workspaceId: string; title: string; bytes: Uint8Array; contentType: string },
    ): Promise<TranscriptionRow> {
      if (pendingBytes + input.bytes.byteLength > MAX_PENDING_BYTES) {
        throw new TranscriptionQueueFullError();
      }
      const row = await store.create(
        { id: newTranscriptionId(), workspaceId: input.workspaceId, title: input.title, bytes: input.bytes.byteLength },
      );
      pending.push({
        id: row.id,
        workspaceId: input.workspaceId,
        title: input.title,
        bytes: input.bytes,
        contentType: input.contentType,
        filename: input.title,
      });
      pendingBytes += input.bytes.byteLength;
      void drain();
      return row;
    },

    /** Close rows orphaned by a previous API process, mirroring runs. */
    async recoverInterrupted(): Promise<number> {
      return store.stopInterrupted();
    },
  };
}

export type Transcriber = ReturnType<typeof createTranscriber>;

export const transcriptionQueue = createTranscriber();
