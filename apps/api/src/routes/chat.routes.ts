import { Hono } from "hono";
import * as chatController from "../controllers/chat.controller";

export const chatRoutes = new Hono();

chatRoutes.post("/", chatController.stream);
