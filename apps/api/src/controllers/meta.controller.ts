import type { Context } from "hono";
import { getMeta } from "../services/agent/model.service";
import { APP_VERSION } from "../lib/version";

/** GET /api/meta — the harness + model catalog the UI renders, plus the build version. */
export function show(c: Context) {
  return c.json({ version: APP_VERSION, ...getMeta() });
}
