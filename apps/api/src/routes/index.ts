import { Hono } from "hono";
import { metaRoutes } from "./meta.routes";
import { meRoutes } from "./me.routes";
import { chatRoutes } from "./chat.routes";
import { conversationRoutes } from "./conversation.routes";
import { documentRoutes } from "./document.routes";
import { workspaceRoutes } from "./workspace.routes";
import { workspaceRegistryRoutes } from "./workspace-registry.routes";
import { databaseRoutes } from "./database.routes";
import { mcpRoutes } from "./mcp.routes";
import { connectorRoutes } from "./connector.routes";
import { playbookRoutes } from "./playbook.routes";
import { imageRoutes } from "./image.routes";
import { adminRoutes } from "./admin.routes";
import { organizationRoutes } from "./organization.routes";
import { invitationRoutes } from "./invitation.routes";
import { agentRoutes } from "./agent.routes";

/** Every HTTP surface the API exposes, mounted under /api. */
export const apiRoutes = new Hono();

apiRoutes.route("/meta", metaRoutes);
// Who the authenticating proxy says you are. Behind auth, unlike /meta.
apiRoutes.route("/me", meRoutes);
apiRoutes.route("/chat", chatRoutes);
apiRoutes.route("/conversations", conversationRoutes);
apiRoutes.route("/documents", documentRoutes);
// `/workspace` (singular) is the sandbox's files; `/workspaces` is the
// containers themselves.
apiRoutes.route("/workspace", workspaceRoutes);
apiRoutes.route("/workspaces", workspaceRegistryRoutes);
apiRoutes.route("/databases", databaseRoutes);
apiRoutes.route("/mcp", mcpRoutes);
apiRoutes.route("/connectors", connectorRoutes);
// What this workspace has learned about its own work, and the one control over
// it: delete. Written by the reflector after a run, never by a client.
apiRoutes.route("/playbook", playbookRoutes);
// Generated media. `GET /:id` is what the markdown image links in a transcript
// resolve to, so this path is effectively public within the console.
apiRoutes.route("/images", imageRoutes);
// Super-admin-only platform activity, users, and recorded runs.
apiRoutes.route("/admin", adminRoutes);
// Elevated organization administration shares the same email allowlist.
apiRoutes.route("/admin/organizations", organizationRoutes);
// Authenticated invitees inspect/accept a token sent only in a JSON body.
apiRoutes.route("/invitations", invitationRoutes);
// User-managed prompt agents. Only POST /invoke bypasses proxy identity; its
// bearer key is the credential external callers such as Telegram relays use.
apiRoutes.route("/agents", agentRoutes);
