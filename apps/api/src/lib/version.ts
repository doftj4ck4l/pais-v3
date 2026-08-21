import fs from "node:fs";
import path from "node:path";

/**
 * The running app's version.
 *
 * One source of truth: the repo-root `VERSION` file, baked into the image (the
 * api Dockerfile COPYs it). The file wins on purpose — it is the version of the
 * code actually running, so a stale `PIXELSPACE_VERSION` in the deployment env
 * (the installer keeps one for its own CLI tracking) can never make the app
 * misreport itself. `PIXELSPACE_VERSION` is only a fallback for a build that
 * somehow shipped without the file.
 *
 * Falls back to `0.0.0-dev` when neither is present, so this never throws.
 */
function readVersionFile(): string | null {
  // cwd is apps/api both in the container (/app/apps/api) and under `bun dev`,
  // so the repo root — where VERSION lives — is two levels up. /app/VERSION is
  // the container's absolute path, kept as a belt-and-suspenders fallback.
  const candidates = [
    path.resolve(process.cwd(), "..", "..", "VERSION"),
    "/app/VERSION",
  ];
  for (const candidate of candidates) {
    try {
      const value = fs.readFileSync(candidate, "utf8").trim();
      if (value) return value;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

export const APP_VERSION: string =
  readVersionFile() || process.env.PIXELSPACE_VERSION?.trim() || "0.0.0-dev";
