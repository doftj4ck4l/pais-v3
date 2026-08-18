import { Hono } from "hono";
import * as controller from "../controllers/invitation.controller";
import { requireJsonMutation } from "../middleware/json-mutation";

export const invitationRoutes = new Hono();

invitationRoutes.post("/inspect", requireJsonMutation, controller.inspectInvitation);
invitationRoutes.post("/accept", requireJsonMutation, controller.acceptInvitation);
