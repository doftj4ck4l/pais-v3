import { env } from "../../config/env";
import { logger, startTimer } from "../../lib/logger";
import {
  connectorStore,
  type ConnectorStore,
  type OAuthTokens,
} from "../../repositories/connector.repository";
import { documentStore, type DocumentStore } from "../../repositories/document.repository";
import { ingestPdf, ingestText, type DocumentSource } from "../documents/ingest.service";
import * as drive from "./google-drive";

/**
 * Pull a connector's files into the document index.
 *
 * The engine is deliberately ignorant of Google: it asks the provider for
 * `SourceFile`s and content, and hands both to the ingest pipeline that already
 * serves uploads. See `SourceProvider` below for the whole surface it depends
 * on.
 *
 * A sync is idempotent. Running it twice re-indexes nothing, because a file
 * whose version has not moved is skipped before its content is ever fetched —
 * fetching is the expensive part, so the comparison has to happen first.
 */

/**
 * Everything the engine needs from a source, and nothing Google-specific.
 *
 * The Drive module satisfies this structurally, so it is passed as the default
 * rather than imported at each call site. A second provider implements these
 * six functions and needs no change here — which is only true because the
 * engine takes the provider as a parameter, not as an import.
 */
export type SourceProvider = {
  needsRefresh(tokens: OAuthTokens): boolean;
  refresh(tokens: OAuthTokens): Promise<OAuthTokens>;
  startCursor(tokens: OAuthTokens): Promise<string | null>;
  recentFiles(tokens: OAuthTokens, limit: number): Promise<drive.SourceFile[]>;
  handlingFor(mimeType: string): drive.FileHandling;
  fetchContent(
    tokens: OAuthTokens,
    file: drive.SourceFile,
  ): Promise<{ text: string } | { bytes: Uint8Array }>;
};

export type SyncOutcome = {
  connectorId: string;
  indexed: number;
  updated: number;
  unchanged: number;
  removed: number;
  skipped: { title: string; reason: string }[];
  failed: { title: string; reason: string }[];
  ms: number;
};

/**
 * Make sure the access token is usable, refreshing and persisting if not.
 *
 * Returned rather than mutated in place so the caller uses the fresh token
 * without having to know a refresh happened.
 */
async function usableTokens(
  workspaceId: string,
  connectorId: string,
  tokens: OAuthTokens,
  store: ConnectorStore,
  provider: SourceProvider,
): Promise<OAuthTokens> {
  if (!provider.needsRefresh(tokens)) return tokens;
  const next = await provider.refresh(tokens);
  await store.saveTokens(workspaceId, connectorId, next);
  logger.info("connector.refreshed", { connectorId });
  return next;
}

export async function syncConnector(
  workspaceId: string,
  connectorId: string,
  store: ConnectorStore = connectorStore,
  docs: DocumentStore = documentStore,
  provider: SourceProvider = drive,
  limit: number = env.connectorSyncLimit,
): Promise<SyncOutcome> {
  const timer = startTimer();
  const connector = await store.get(workspaceId, connectorId);
  if (!connector) throw new Error("connector not found");

  const stored = await store.tokens(workspaceId, connectorId);
  if (!stored) throw new Error("no stored credentials — reconnect the account");

  const outcome: SyncOutcome = {
    connectorId,
    indexed: 0,
    updated: 0,
    unchanged: 0,
    removed: 0,
    skipped: [],
    failed: [],
    ms: 0,
  };

  await store.markStatus(workspaceId, connectorId, "syncing", null);

  try {
    const tokens = await usableTokens(workspaceId, connectorId, stored, store, provider);

    // Taken before listing: a cursor taken afterwards would silently skip
    // anything modified while the listing was in flight.
    const cursor = await provider.startCursor(tokens);

    const files = await provider.recentFiles(tokens, limit);
    const known = await docs.bySource(workspaceId, connectorId);
    const seen = new Set<string>();

    for (const file of files) {
      seen.add(file.externalId);
      const existing = known.get(file.externalId);

      if (existing && existing.externalVersion === file.version) {
        outcome.unchanged++;
        continue;
      }

      const handling = provider.handlingFor(file.mimeType);
      if (handling.kind === "skip") {
        outcome.skipped.push({ title: file.title, reason: handling.reason });
        continue;
      }

      const source: DocumentSource = {
        connectorId,
        externalId: file.externalId,
        externalVersion: file.version,
        externalUrl: file.url,
      };

      try {
        const content = await provider.fetchContent(tokens, file);

        // Replace, never merge. Re-indexing on top of the old rows would leave
        // chunks from the previous revision in the FTS index, and a search
        // would cite a sentence the document no longer contains.
        if (existing) await docs.remove(workspaceId, existing.documentId);

        const result =
          "bytes" in content
            ? await ingestPdf(workspaceId, file.title, content.bytes, docs, source)
            : await ingestText(workspaceId, file.title, content.text, docs, source);

        if (result.status === "indexed") {
          if (existing) outcome.updated++;
          else outcome.indexed++;
        } else {
          // `empty` and `error` documents are stored with their reason, which
          // is the whole point — but they are not indexed content.
          outcome.skipped.push({ title: file.title, reason: result.error ?? result.status });
        }
      } catch (e) {
        // One unreadable file must not end the sync. A Drive with a single
        // export-restricted document would otherwise index nothing at all.
        const reason = (e as Error)?.message ?? String(e);
        outcome.failed.push({ title: file.title, reason });
        logger.warn("connector.file_failed", { connectorId, title: file.title, reason });
      }
    }

    // Absence means deletion — the same contract a bulk push API uses. Bounded
    // to what this sync actually looked at: with a capped listing, a file that
    // simply fell out of the most-recent window has not been deleted, so only
    // ids we could have seen are eligible.
    if (files.length < limit) {
      for (const [externalId, indexed] of known) {
        if (seen.has(externalId)) continue;
        await docs.remove(workspaceId, indexed.documentId);
        outcome.removed++;
      }
    }

    await store.saveCursor(workspaceId, connectorId, cursor);
    await store.markStatus(workspaceId, connectorId, "connected", null);
  } catch (e) {
    const message = (e as Error)?.message ?? String(e);
    await store.markStatus(workspaceId, connectorId, "error", message);
    logger.warn("connector.sync_failed", { connectorId, message });
    throw e;
  }

  outcome.ms = timer.elapsed();
  logger.info("connector.synced", {
    connectorId,
    ms: outcome.ms,
    indexed: outcome.indexed,
    updated: outcome.updated,
    unchanged: outcome.unchanged,
    removed: outcome.removed,
    skipped: outcome.skipped.length,
    failed: outcome.failed.length,
  });
  return outcome;
}
