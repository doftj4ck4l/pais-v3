import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/models/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: "./data/app.db",
  },
});
