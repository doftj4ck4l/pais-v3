import { Hono } from "hono";
import {
  googleAuth,
  googleCallback,
  list,
  remove,
  sync,
} from "../controllers/connector.controller";

export const connectorRoutes = new Hono();

connectorRoutes.get("/", list);
// Provider-specific, and deliberately so: OAuth shapes differ per provider, and
// a "generic" endpoint would be a switch statement wearing a costume.
connectorRoutes.get("/google/auth", googleAuth);
connectorRoutes.get("/google/callback", googleCallback);
connectorRoutes.post("/:id/sync", sync);
connectorRoutes.delete("/:id", remove);
