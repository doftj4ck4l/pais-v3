import type { OAuthTokens } from "../../repositories/connector.repository";
import { buildAuthUrl } from "./google-oauth";

/**
 * Google Drive, as far as this codebase is concerned.
 *
 * The only module that knows Drive's URLs, scopes, and export formats — the
 * sync engine above it works in `SourceFile`s and never sees a Google concept.
 * A second connector lands here as a sibling, not as a change to the sync.
 * The OAuth dance itself is shared with every Google connector and lives in
 * `google-oauth.ts`; this module re-exports the pieces the controller and sync
 * engine already reach for by name.
 *
 * Authentication is the *user's* OAuth grant, not an admin credential. Every
 * request below therefore returns exactly what that person can see in Drive,
 * which is why nothing here models permissions.
 */

const DRIVE_API = "https://www.googleapis.com/drive/v3";

/**
 * Read-only, and metadata alongside content because the sync needs modified
 * times and versions to skip unchanged files. `drive.readonly` covers both;
 * asking for anything writable would be a scope the connector never uses.
 */
const SCOPES = ["https://www.googleapis.com/auth/drive.readonly"];

export { redirectUri, isConfigured, exchangeCode, refresh, needsRefresh } from "./google-oauth";

/** Where to send the browser to get consent, scoped to Drive. */
export function authUrl(state: string): string {
  return buildAuthUrl(state, SCOPES);
}

async function driveFetch(tokens: OAuthTokens, path: string): Promise<Response> {
  const res = await fetch(`${DRIVE_API}${path}`, {
    headers: { authorization: `Bearer ${tokens.accessToken}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Drive ${path.split("?")[0]} failed (HTTP ${res.status}): ${body.slice(0, 300)}`);
  }
  return res;
}

/** Which account a grant belongs to. Cheaper than adding a userinfo scope. */
export async function accountEmail(tokens: OAuthTokens): Promise<string | null> {
  const res = await driveFetch(tokens, "/about?fields=user(emailAddress)");
  const json = (await res.json()) as { user?: { emailAddress?: string } };
  return json.user?.emailAddress ?? null;
}

/** A file as the sync engine sees it, with no Google vocabulary left. */
export type SourceFile = {
  externalId: string;
  title: string;
  /** Drive's `version`, monotonically increasing per file. */
  version: string;
  url: string | null;
  mimeType: string;
  /** Absent for Google-native files, which have no byte size of their own. */
  bytes: number;
};

type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  version?: string;
  modifiedTime?: string;
  size?: string;
  webViewLink?: string;
  trashed?: boolean;
};

/**
 * How each Drive type becomes text.
 *
 * Google-native files have no bytes to download — they are exported, and the
 * export format is the extraction. Docs come back as Markdown because chunking
 * splits on paragraph boundaries and headings, so structure that survives the
 * export keeps a section together downstream.
 */
const EXPORT_AS: Record<string, string> = {
  "application/vnd.google-apps.document": "text/markdown",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};

/** Downloadable types worth indexing. Everything else is skipped by name. */
const TEXT_LIKE = /^(text\/|application\/(json|xml|x-yaml|yaml|javascript|typescript))/;

export type FileHandling =
  | { kind: "export"; mimeType: string }
  | { kind: "pdf" }
  | { kind: "text" }
  | { kind: "skip"; reason: string };

export function handlingFor(mimeType: string): FileHandling {
  const exportAs = EXPORT_AS[mimeType];
  if (exportAs) return { kind: "export", mimeType: exportAs };
  if (mimeType === "application/pdf") return { kind: "pdf" };
  if (TEXT_LIKE.test(mimeType)) return { kind: "text" };
  // Folders, shortcuts, forms, images, video, binaries. Named rather than
  // silently dropped: "why is that file missing" is the first question a sync
  // has to be able to answer.
  return { kind: "skip", reason: `unsupported type ${mimeType}` };
}

/**
 * The most recently modified files this account can see.
 *
 * Shared drives are included explicitly — the two `*AllDrives` parameters are
 * both required, and omitting them silently returns only My Drive, which looks
 * like a permissions problem rather than a missing query parameter.
 */
export async function recentFiles(tokens: OAuthTokens, limit: number): Promise<SourceFile[]> {
  const params = new URLSearchParams({
    q: "trashed = false and mimeType != 'application/vnd.google-apps.folder'",
    orderBy: "modifiedTime desc",
    pageSize: String(Math.max(1, Math.min(1000, limit))),
    fields: "files(id,name,mimeType,version,modifiedTime,size,webViewLink,trashed)",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });
  const res = await driveFetch(tokens, `/files?${params.toString()}`);
  const json = (await res.json()) as { files?: DriveFile[] };
  return (json.files ?? []).map((f) => ({
    externalId: f.id,
    title: f.name,
    version: String(f.version ?? f.modifiedTime ?? ""),
    url: f.webViewLink ?? null,
    mimeType: f.mimeType,
    bytes: Number(f.size ?? 0),
  }));
}

/**
 * A change cursor for later incremental syncs.
 *
 * Taken *before* listing files, not after: a token taken afterwards would miss
 * anything modified during the listing itself.
 */
export async function startCursor(tokens: OAuthTokens): Promise<string | null> {
  const res = await driveFetch(tokens, "/changes/startPageToken?supportsAllDrives=true");
  const json = (await res.json()) as { startPageToken?: string };
  return json.startPageToken ?? null;
}

/** The file's content as text, or its raw bytes when a PDF needs extracting. */
export async function fetchContent(
  tokens: OAuthTokens,
  file: SourceFile,
): Promise<{ text: string } | { bytes: Uint8Array }> {
  const handling = handlingFor(file.mimeType);

  if (handling.kind === "export") {
    const path = `/files/${file.externalId}/export?mimeType=${encodeURIComponent(handling.mimeType)}`;
    try {
      const res = await driveFetch(tokens, path);
      return { text: await res.text() };
    } catch (e) {
      // Markdown export is newer than this API and not universally available.
      // Plain text always is, so a rejected format costs formatting, not the
      // file.
      if (handling.mimeType !== "text/markdown") throw e;
      const res = await driveFetch(
        tokens,
        `/files/${file.externalId}/export?mimeType=text%2Fplain`,
      );
      return { text: await res.text() };
    }
  }

  const res = await driveFetch(tokens, `/files/${file.externalId}?alt=media&supportsAllDrives=true`);
  if (handling.kind === "pdf") {
    return { bytes: new Uint8Array(await res.arrayBuffer()) };
  }
  return { text: await res.text() };
}
