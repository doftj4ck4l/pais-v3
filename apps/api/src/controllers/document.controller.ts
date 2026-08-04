import type { Context } from "hono";
import { documentStore } from "../repositories/document.repository";
import { ingestPdf } from "../services/ingest.service";
import { searchDocuments } from "../services/search.service";
import { env } from "../config/env";
import { logger } from "../lib/logger";
import { workspaceRegistry } from "../repositories/workspace-registry.repository";

/**
 * The workspace this request applies to.
 *
 * `resolve` is the one place a client-supplied workspace id is checked against
 * ownership, so every handler below goes through it rather than trusting the
 * query string.
 */
const workspaceIdOf = async (c: Context) => {
  const userId = c.req.query("userId") ?? env.defaultUserId;
  const workspace = await workspaceRegistry.resolve(userId, c.req.query("workspaceId"));
  return workspace.id;
};

/** Cap per file. Generous for a document, small enough to bound a bad upload. */
const MAX_BYTES = 25 * 1024 * 1024;

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
