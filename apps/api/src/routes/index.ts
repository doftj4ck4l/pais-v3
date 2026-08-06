import { Hono } from "hono";
import { metaRoutes } from "./meta.routes";
import { chatRoutes } from "./chat.routes";
import { conversationRoutes } from "./conversation.routes";
import { documentRoutes } from "./document.routes";
import { workspaceRoutes } from "./workspace.routes";
import { workspaceRegistryRoutes } from "./workspace-registry.routes";
import { databaseRoutes } from "./database.routes";
import { mcpRoutes } from "./mcp.routes";
import { adminRoutes } from "./admin.routes";

/** Every HTTP surface the API exposes, mounted under /api. */
export const apiRoutes = new Hono();

apiRoutes.route("/meta", metaRoutes);
apiRoutes.route("/chat", chatRoutes);
apiRoutes.route("/conversations", conversationRoutes);
apiRoutes.route("/documents", documentRoutes);
// `/workspace` (singular) is the sandbox's files; `/workspaces` is the
// containers themselves.
apiRoutes.route("/workspace", workspaceRoutes);
apiRoutes.route("/workspaces", workspaceRegistryRoutes);
apiRoutes.route("/databases", databaseRoutes);
apiRoutes.route("/mcp", mcpRoutes);
// Read-only views over recorded runs. "admin" is the audience, not a permission.
apiRoutes.route("/admin", adminRoutes);
