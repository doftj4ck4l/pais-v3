import type { Context } from "hono";
import { getMeta } from "../services/model.service";

/** GET /api/meta — the harness + model catalog the UI renders. */
export function show(c: Context) {
  return c.json(getMeta());
}
