import { defineConfig } from "drizzle-kit";

/**
 * `models/schema.ts` is the source of truth; `drizzle/` is generated from it.
 *
 * Nothing applies these files from the CLI. `ensureSchema` runs them at boot
 * through `migrate()`, so a deploy that starts the API has already migrated —
 * there is no second command anyone can forget.
 */
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/models/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: "./data/app.db" },
});
