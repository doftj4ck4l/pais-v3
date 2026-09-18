import { Hono } from "hono";
import * as conversationController from "../controllers/conversation.controller";

export const conversationRoutes = new Hono();

conversationRoutes.get("/", conversationController.index);
conversationRoutes.get("/:id", conversationController.show);
conversationRoutes.patch("/:id", conversationController.update);
conversationRoutes.delete("/:id", conversationController.destroy);
