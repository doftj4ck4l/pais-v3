import { logger } from "../../lib/logger";
import {
  transcriptionStore,
  type TranscriptionStore,
} from "../../repositories/transcription.repository";
import type { TranscriptionRow } from "../../models/schema";
import {
  transcribeToCorpus,
  transcriptionAudioBytes,
  type CorpusOutcome,
  type TranscriptionAudioSource,
} from "./transcribe.service";
import {
  transcriptionAudioStorage,
  type TranscriptionAudioStorage,
} from "./transcription-audio.service";

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
 * everything in flight `failed`. Chunked browser uploads remain in temporary
 * files until the worker finishes; the legacy one-request endpoint still uses
 * an in-memory byte array.
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

export type TranscriptionJob = TranscriptionAudioSource & {
  id: string;
  workspaceId: string;
  title: string;
  contentType: string;
  filename: string;
  cleanup?: () => Promise<void>;
};

/** How one job is transcribed once its turn comes. Injected for tests. */
export type RunTranscription = (
  job: TranscriptionJob,
  reportStage: (stage: "indexing") => Promise<void>,
) => Promise<CorpusOutcome>;

/** Upper bound on audio bytes waiting in line, whether memory- or disk-backed. */
const MAX_PENDING_BYTES = 2 * 1024 * 1024 * 1024;

const newTranscriptionId = () =>
  `trx_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export function createTranscriber(
  deps: {
    store?: TranscriptionStore;
    run?: RunTranscription;
    audioStorage?: TranscriptionAudioStorage;
  } = {},
) {
  const store = deps.store ?? transcriptionStore;
  const audioStorage = deps.audioStorage ?? transcriptionAudioStorage;
  const run = deps.run ?? ((job, reportStage) => transcribeToCorpus(
    job.workspaceId,
    job.title,
    job,
    { onIndexing: () => reportStage("indexing") },
  ));

  const pending: TranscriptionJob[] = [];
  let pendingBytes = 0;
  let running = false;

  const drain = async () => {
    if (running) return;
    running = true;
    try {
      while (pending.length) {
        const job = pending.shift()!;
        pendingBytes -= transcriptionAudioBytes(job);
        await runJob(job);
      }
    } finally {
      running = false;
    }
  };

  const runJob = async (job: TranscriptionJob) => {
    await store.markTranscribing(job.id);
    try {
      const outcome = await run(job, async (stage) => {
        if (stage === "indexing") await store.markIndexing(job.id);
      });
      if (outcome.ok) {
        await store.markDone(job.id, outcome.documentId, outcome.model, outcome.text);
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
    } finally {
      if (job.cleanup) {
        try {
          await job.cleanup();
        } catch (e: any) {
          logger.warn("transcribe.job.cleanup_failed", {
            transcriptionId: job.id,
            message: String(e?.message ?? e),
          });
        }
      }
    }
  };

  return {
    pendingCount: () => pending.length,

    /** Record the job and start working it. Resolves once it is safe in line. */
    async enqueue(
      input: {
        workspaceId: string;
        title: string;
        contentType: string;
        cleanup?: () => Promise<void>;
      } & TranscriptionAudioSource,
    ): Promise<TranscriptionRow> {
      const byteLength = transcriptionAudioBytes(input);
      if (pendingBytes + byteLength > MAX_PENDING_BYTES) {
        throw new TranscriptionQueueFullError();
      }
      const id = newTranscriptionId();
      const saved = await audioStorage.save({
        id,
        workspaceId: input.workspaceId,
        title: input.title,
        contentType: input.contentType,
        source: input,
        moveSource: "filePath" in input && Boolean(input.cleanup),
      });
      let row: TranscriptionRow;
      try {
        row = await store.create({
          id,
          workspaceId: input.workspaceId,
          title: input.title,
          bytes: byteLength,
          audioPath: saved.relativePath,
          audioContentType: saved.contentType,
        });
      } catch (error) {
        await audioStorage.remove(input.workspaceId, saved.relativePath).catch(() => undefined);
        throw error;
      }

      // Chunk-upload temp files can disappear as soon as their durable copy is
      // complete. The queue and Whisper now read the persistent recording.
      if (input.cleanup) {
        try {
          await input.cleanup();
        } catch (error: any) {
          logger.warn("transcribe.upload.cleanup_failed", {
            transcriptionId: id,
            message: String(error?.message ?? error),
          });
        }
      }

      pending.push({
        id,
        workspaceId: input.workspaceId,
        title: input.title,
        filename: input.title,
        filePath: saved.absolutePath,
        byteLength: saved.byteLength,
        contentType: saved.contentType,
      });
      pendingBytes += byteLength;
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
