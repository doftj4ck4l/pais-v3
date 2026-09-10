import type { Context } from "hono";
import { documentStore } from "../repositories/document.repository";
import { transcriptionStore } from "../repositories/transcription.repository";
import { ingestPdf } from "../services/documents/ingest.service";
import { transcriptionQueue, TranscriptionQueueFullError } from "../services/documents/transcription-queue";
import {
  MAX_TRANSCRIPTION_BYTES,
  TranscriptionUploadError,
  transcriptionUploadStore,
} from "../services/documents/transcription-upload.service";
import { searchDocuments } from "../services/documents/search.service";
import { logger } from "../lib/logger";
import { workspaceRegistry } from "../repositories/workspace-registry.repository";
import { currentUserId } from "../middleware/auth";

/**
 * The workspace this request applies to.
 *
 * `resolve` is the one place a client-supplied workspace id is checked against
 * ownership, so every handler below goes through it rather than trusting the
 * query string.
 */
const workspaceIdOf = async (c: Context) => {
  const userId = currentUserId(c);
  const workspace = await workspaceRegistry.resolve(userId, c.req.query("workspaceId"));
  return workspace.id;
};

/** Cap per file. Generous for a document, small enough to bound a bad upload. */
const MAX_BYTES = 25 * 1024 * 1024;

/**
 * Cap an audio upload. A recording is bigger than a page: an hour of MP3 at
 * 128kbps is ~57MB, and whisper wants the whole file, not a clip.
 */
/** GET /api/documents — a workspace's uploads, newest first. */
export async function index(c: Context) {
  const documents = await documentStore.list(await workspaceIdOf(c));
  return c.json({ documents });
}

/**
 * POST /api/documents — upload and index one or more files (multipart).
 *
 * Each file is reported individually. One unreadable PDF in a batch of ten must
 * not fail the other nine, so per-file outcomes are collected rather than thrown.
 */
export async function create(c: Context) {
  const workspaceId = await workspaceIdOf(c);

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: "Expected a multipart/form-data body" }, 400);
  }

  const files = form.getAll("files").filter((f): f is File => f instanceof File);
  if (!files.length) return c.json({ error: "No files supplied under the 'files' field" }, 400);

  const results = [];
  for (const file of files) {
    if (file.size > MAX_BYTES) {
      results.push({
        title: file.name,
        status: "error" as const,
        pages: 0,
        chunks: 0,
        error: `file is ${(file.size / 1e6).toFixed(1)}MB, over the ${MAX_BYTES / 1e6}MB limit`,
      });
      continue;
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      results.push(await ingestPdf(workspaceId, file.name, bytes, documentStore));
    } catch (e: any) {
      logger.error("upload.failed", { title: file.name, message: e?.message ?? String(e) });
      results.push({
        title: file.name,
        status: "error" as const,
        pages: 0,
        chunks: 0,
        error: e?.message ?? String(e),
      });
    }
  }

  return c.json({ results }, 201);
}

/**
 * POST /api/documents/transcribe — put an audio file through the queue.
 *
 * Separate from `create` because an audio file is not a PDF and should not be
 * sent through the PDF extractor blind: the two pipelines have different size
 * caps, different failure modes, and a whisper upload that fell into the PDF
 * path would fail as "unreadable" without ever naming whisper.
 *
 * This no longer runs whisper inline. The upload is recorded and the request
 * answers 202 the moment it is queued; the `transcriptions` page shows the
 * job's status from there. An oversized file is refused outright (413) rather
 * than queued to fail later, and a full queue answers 429 so the client can
 * surface "busy" instead of silently sitting at "done" forever.
 */
export async function transcribe(c: Context) {
  const workspaceId = await workspaceIdOf(c);

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: "Expected a multipart/form-data body" }, 400);
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return c.json({ error: "No audio file supplied under the 'file' field" }, 400);
  }

  if (file.size > MAX_TRANSCRIPTION_BYTES) {
    return c.json(
      {
        error: `file is ${(file.size / 1e6).toFixed(1)}MB, over the ${MAX_TRANSCRIPTION_BYTES / 1024 / 1024}MiB limit`,
      },
      413,
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    const row = await transcriptionQueue.enqueue({ workspaceId, title: file.name, bytes, contentType: file.type });
    return c.json({ transcriptionId: row.id, status: row.status }, 202);
  } catch (e) {
    if (e instanceof TranscriptionQueueFullError) {
      return c.json({ error: e.message }, 429);
    }
    throw e;
  }
}

/** Start a chunked recording upload. The recording itself is not sent here. */
export async function createTranscriptionUpload(c: Context) {
  const workspaceId = await workspaceIdOf(c);
  let input: unknown;
  try {
    input = await c.req.json();
  } catch {
    return c.json({ error: "Expected a JSON upload description" }, 400);
  }
  if (!input || typeof input !== "object") {
    return c.json({ error: "Expected a JSON upload description" }, 400);
  }

  const body = input as Record<string, unknown>;
  if (typeof body.title !== "string" || typeof body.contentType !== "string" || typeof body.size !== "number") {
    return c.json({ error: "title, contentType, and size are required" }, 400);
  }
  try {
    return c.json(
      await transcriptionUploadStore.create(workspaceId, {
        title: body.title,
        contentType: body.contentType,
        size: body.size,
      }),
      201,
    );
  } catch (error) {
    return transcriptionUploadFailure(c, error);
  }
}

/** Accept one small raw chunk, ordered so retries cannot silently corrupt it. */
export async function appendTranscriptionUpload(c: Context) {
  const workspaceId = await workspaceIdOf(c);
  const id = c.req.param("id");
  if (!id) return c.json({ error: "Missing upload id" }, 400);
  const part = Number(c.req.param("part"));
  try {
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    return c.json(await transcriptionUploadStore.append(workspaceId, id, part, bytes));
  } catch (error) {
    return transcriptionUploadFailure(c, error);
  }
}

/** Assemble a completed upload and put it on the existing FIFO worker. */
export async function completeTranscriptionUpload(c: Context) {
  const workspaceId = await workspaceIdOf(c);
  const id = c.req.param("id");
  if (!id) return c.json({ error: "Missing upload id" }, 400);
  let upload: Awaited<ReturnType<typeof transcriptionUploadStore.finish>> | undefined;
  try {
    upload = await transcriptionUploadStore.finish(workspaceId, id);
    const row = await transcriptionQueue.enqueue({ workspaceId, ...upload });
    return c.json({ transcriptionId: row.id, status: row.status }, 202);
  } catch (error) {
    // Once finish detaches the session, the queue owns the temp file only if
    // enqueue succeeds. Avoid leaking it when the queue rejects the job.
    if (upload) await upload.cleanup();
    if (error instanceof TranscriptionQueueFullError) return c.json({ error: error.message }, 429);
    return transcriptionUploadFailure(c, error);
  }
}

/** Abandon chunks after a browser/network failure and delete their temp file. */
export async function destroyTranscriptionUpload(c: Context) {
  const workspaceId = await workspaceIdOf(c);
  const id = c.req.param("id");
  if (!id) return c.json({ error: "Missing upload id" }, 400);
  try {
    await transcriptionUploadStore.cancel(workspaceId, id);
    return c.body(null, 204);
  } catch (error) {
    return transcriptionUploadFailure(c, error);
  }
}

function transcriptionUploadFailure(c: Context, error: unknown) {
  if (error instanceof TranscriptionUploadError) {
    return c.json({ error: error.message }, error.status);
  }
  throw error;
}

/** GET /api/documents/transcriptions — a workspace's jobs, newest first. */
export async function listTranscriptions(c: Context) {
  const transcriptions = await transcriptionStore.list(await workspaceIdOf(c));
  return c.json({ transcriptions });
}

/** GET /api/documents/transcriptions/:id — one job and its readable transcript. */
export async function showTranscription(c: Context) {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "Missing transcription id" }, 400);

  const workspaceId = await workspaceIdOf(c);
  const transcription = await transcriptionStore.find(workspaceId, id);
  if (!transcription) return c.json({ error: "Transcription not found" }, 404);

  const document = transcription.documentId
    ? await documentStore.read(workspaceId, transcription.documentId)
    : null;
  return c.json({ transcription, content: document?.content ?? null });
}

/**
 * GET /api/documents/transcriptions/:id/transcript — the finished transcript
 * as a downloadable `.txt` file.
 *
 * The text is the exact `[MM:SS] line` output the job was marked done with;
 * the corpus chunks say the same words but the chunker decided their
 * boundaries. Only a finished job has one, and only within its own workspace.
 */
export async function transcript(c: Context) {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "Missing transcription id" }, 400);

  const job = await transcriptionStore.find(await workspaceIdOf(c), id);
  if (!job || job.status !== "done" || !job.transcriptText) {
    return c.json({ error: "Transcript not found" }, 404);
  }

  const filename = `${job.title.replace(/\.[^.]+$/, "")}.txt`;
  return c.body(job.transcriptText, 200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename.slice(0, 60)}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
  });
}

/**
 * DELETE /api/documents/transcriptions/:id — drop the job *and* its transcript.
 *
 * The `document_id` foreign key is `set null`, so the transcript would survive
 * in the corpus if only the job row were removed — but on this page the tile is
 * the record of the upload, and both are deleted together. The corpus stays
 * consistent: deleting a `documents` row on the Docs page leaves the (already
 * finished, already displayed) job row behind, unlinked.
 */
export async function destroyTranscription(c: Context) {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "Missing transcription id" }, 400);

  const workspaceId = await workspaceIdOf(c);
  const job = await transcriptionStore.find(workspaceId, id);
  if (!job) return c.json({ error: "Transcription not found" }, 404);

  await transcriptionStore.remove(workspaceId, id);
  if (job.documentId) await documentStore.remove(workspaceId, job.documentId);
  return c.body(null, 204);
}

/** DELETE /api/documents/:id — removes its chunks and its search index entries. */
export async function destroy(c: Context) {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "Missing document id" }, 400);

  const removed = await documentStore.remove(await workspaceIdOf(c), id);
  if (!removed) return c.json({ error: "Document not found" }, 404);
  return c.body(null, 204);
}

/**
 * GET /api/documents/search?q= — the same retrieval the agent uses.
 *
 * Exposed so retrieval can be inspected directly, without a model in the loop:
 * when an answer looks wrong, this says whether the search or the model was at
 * fault.
 */
export async function search(c: Context) {
  const q = c.req.query("q") ?? "";
  const limit = Number(c.req.query("limit") ?? 5) || 5;
  const result = await searchDocuments(await workspaceIdOf(c), q, limit);

  if (!result.ok) return c.json({ hits: [], reason: result.reason }, 200);
  return c.json({ hits: result.hits, ftsQuery: result.query });
}
