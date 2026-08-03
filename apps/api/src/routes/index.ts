import { Hono } from "hono";
import { metaRoutes } from "./meta.routes";
import { chatRoutes } from "./chat.routes";
import { conversationRoutes } from "./conversation.routes";
import { documentRoutes } from "./document.routes";

/** Every HTTP surface the API exposes, mounted under /api. */
export const apiRoutes = new Hono();

apiRoutes.route("/meta", metaRoutes);
apiRoutes.route("/chat", chatRoutes);
apiRoutes.route("/conversations", conversationRoutes);
apiRoutes.route("/documents", documentRoutes);
