import type { Context } from "hono";
import { env } from "../config/env";
import { logger } from "../lib/logger";
import { connectorStore } from "../repositories/connector.repository";
import { documentStore } from "../repositories/document.repository";
import { workspaceRegistry } from "../repositories/workspace-registry.repository";
import * as drive from "../services/connectors/google-drive";
import { syncConnector } from "../services/connectors/sync.service";
import { currentUserId } from "../middleware/auth";

/**
 * Connectors: authorise a remote source, then pull it into the document index.
 *
 * The OAuth round trip leaves this process entirely — the browser goes to
 * Google and comes back — so the workspace has to survive the trip. It rides in
 * the `state` parameter, which is also the CSRF defence: a callback whose state
 * does not decode to a workspace this user owns is rejected before a token is
 * ever requested.
 */

const newConnectorId = () =>
  `con_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

async function scope(c: Context): Promise<{ id: string }> {
  const userId = currentUserId(c);
  return workspaceRegistry.resolve(userId, c.req.query("workspaceId"));
}

/** GET /api/connectors — what this workspace has connected. */
export async function list(c: Context) {
  const workspace = await scope(c);
  const rows = await connectorStore.list(workspace.id);
  const docs = await documentStore.list(workspace.id);

  return c.json({
    // Named so the UI can explain *why* the button is missing rather than
    // rendering a control that fails on click.
    available: drive.isConfigured()
      ? []
      : [{ kind: "gdrive", reason: "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set" }],
    connectors: rows.map((row) => ({
      ...row,
      documentCount: docs.filter((d) => d.connectorId === row.id).length,
    })),
  });
}

/**
 * GET /api/connectors/google/auth — begin the consent flow.
 *
 * Returns the URL rather than redirecting: the caller is a fetch from the SPA,
 * and a 302 to accounts.google.com would be blocked by CORS before the user
 * ever saw a consent screen.
 */
export async function googleAuth(c: Context) {
  if (!drive.isConfigured()) {
    return c.json(
      {
        error:
          "Google is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in apps/api/.env, " +
          `and add ${drive.redirectUri()} as an authorized redirect URI on the OAuth client.`,
      },
      400,
    );
  }
  const workspace = await scope(c);
  const state = Buffer.from(JSON.stringify({ workspaceId: workspace.id })).toString("base64url");
  return c.json({ url: drive.authUrl(state) });
}

/**
 * GET /api/connectors/google/callback — Google sends the browser back here.
 *
 * The response is HTML, not JSON: this is a real navigation in a real tab, and
 * whoever is looking at it needs to be told what happened and to close it.
 */
export async function googleCallback(c: Context) {
  const error = c.req.query("error");
  if (error) return c.html(page("Authorisation cancelled", error), 400);

  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) return c.html(page("Missing code", "Google sent no authorisation code."), 400);

  let workspaceId: string;
  try {
    workspaceId = JSON.parse(Buffer.from(state, "base64url").toString()).workspaceId;
    if (!workspaceId) throw new Error("no workspace");
  } catch {
    return c.html(page("Invalid state", "The callback did not carry a usable workspace."), 400);
  }

  try {
    const tokens = await drive.exchangeCode(code);
    if (!tokens.refreshToken) {
      // Without one the connector works for an hour and then silently stops,
      // which is worse than refusing now.
      return c.html(
        page(
          "No refresh token",
          "Google did not return a refresh token. Remove this app at " +
            "myaccount.google.com/permissions and connect again.",
        ),
        400,
      );
    }

    const email = await drive.accountEmail(tokens);
    const existing = email
      ? await connectorStore.findByAccount(workspaceId, "gdrive", email)
      : null;

    if (existing) {
      // Re-authorising an account already connected replaces its credentials
      // rather than adding a second connector that would sync the same files.
      await connectorStore.saveTokens(workspaceId, existing.id, tokens);
      await connectorStore.markStatus(workspaceId, existing.id, "connected", null);
      logger.info("connector.reauthorised", { connectorId: existing.id, email });
    } else {
      const id = newConnectorId();
      await connectorStore.create({
        id,
        workspaceId,
        kind: "gdrive",
        accountEmail: email,
        tokens,
      });
      logger.info("connector.created", { connectorId: id, email });
    }

    return c.html(
      page(
        "Google Drive connected",
        `${email ?? "Your account"} is connected. Close this tab and run a sync.`,
      ),
    );
  } catch (e) {
    const message = (e as Error)?.message ?? String(e);
    logger.warn("connector.oauth_failed", { message });
    return c.html(page("Could not connect", message), 400);
  }
}

/** POST /api/connectors/:id/sync — pull files now. */
export async function sync(c: Context) {
  const workspace = await scope(c);
  const id = c.req.param("id") ?? "";
  try {
    return c.json(await syncConnector(workspace.id, id));
  } catch (e) {
    return c.json({ error: (e as Error)?.message ?? String(e) }, 400);
  }
}

/** DELETE /api/connectors/:id — disconnect, and drop what it indexed. */
export async function remove(c: Context) {
  const workspace = await scope(c);
  const id = c.req.param("id") ?? "";
  // Documents first: a connector removed while its documents remained would
  // leave rows nothing can re-sync, refresh, or attribute.
  const removed = await documentStore.removeByConnector(workspace.id, id);
  const ok = await connectorStore.remove(workspace.id, id);
  if (!ok) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true, documentsRemoved: removed });
}

/** The callback lands in a browser tab, so it answers in HTML. */
function page(title: string, detail: string): string {
  const escape = (s: string) =>
    s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
  return `<!doctype html><meta charset="utf-8"><title>${escape(title)}</title>
<style>
  body { font: 15px/1.6 ui-sans-serif, system-ui, sans-serif; margin: 0;
         display: grid; place-items: center; min-height: 100vh; background: #0b0b0c; color: #e7e7e9 }
  main { max-width: 30rem; padding: 2rem; text-align: center }
  h1 { font-size: 1.05rem; margin: 0 0 .5rem }
  p { margin: 0; color: #a1a1aa; font-size: .875rem }
</style>
<main><h1>${escape(title)}</h1><p>${escape(detail)}</p></main>`;
}
