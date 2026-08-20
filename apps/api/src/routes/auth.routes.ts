import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import * as controller from "../controllers/auth.controller";
import { requireJsonMutation } from "../middleware/json-mutation";

export const authRoutes = new Hono();
const MAX_LOGIN_BODY_BYTES = 8 * 1024;

authRoutes.get("/config", controller.config);
authRoutes.post(
  "/login",
  requireJsonMutation,
  bodyLimit({
    maxSize: MAX_LOGIN_BODY_BYTES,
    onError: (c) => c.json({ error: "Request body is too large." }, 413),
  }),
  controller.login,
);
authRoutes.post("/logout", requireJsonMutation, controller.logout);
