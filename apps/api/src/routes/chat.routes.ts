import { Hono } from "hono";
import * as chatController from "../controllers/chat.controller";

export const chatRoutes = new Hono();

chatRoutes.post("/", chatController.stream);
// Cancel a run in flight. Its own path because the SSE POST above never
// returns while the run is live, so a stop has to arrive on a second request.
chatRoutes.post("/:conversationId/stop", chatController.stop);
