import { Hono } from "hono";
import * as controller from "../controllers/agent.controller";
import { requireJsonMutation, requireSameOrigin } from "../middleware/json-mutation";

export const agentRoutes = new Hono();

agentRoutes.post("/invoke", requireJsonMutation, controller.invoke);
agentRoutes.get("/", controller.index);
agentRoutes.post("/", requireJsonMutation, controller.create);
agentRoutes.patch("/:id", requireJsonMutation, controller.update);
agentRoutes.post("/:id/token", requireJsonMutation, controller.rotateToken);
agentRoutes.post("/:id/preview", requireJsonMutation, controller.preview);
agentRoutes.delete("/:id", requireSameOrigin, controller.destroy);
