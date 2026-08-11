---
name: deploy
description: Use when the user says "deploy", "ship it", "push it live", or asks to release finished work to the running server. Covers the local docker compose stack that serves Salur on this host.
---

# Deploy

Deploys this checkout to the docker compose stack running on this host.
`web` (Caddy) is published on `WEB_PORT`; `api` (Bun) is reachable only through
`/api` on that port. The agent's sandbox containers are siblings started by the
API through the host's Docker socket.

**Never deploy a red build.** The image build runs `tsc -b`, so a type error
already fails the deploy — but the API test suite does not run in the image.
Step 1 is not optional.

## Preconditions

Check these before the first deploy on a new machine. On later deploys they are
already true.

| Requirement | Check | Fix |
| --- | --- | --- |
| `.env` exists at the repo root | `test -f .env` | `cp .env.example .env` then fill in `CONNECTION_SECRET` and model keys |
| `S3_SECRET_KEY` set in `.env` | `docker compose config -q` | Generate one: `openssl rand -base64 24`. Compose refuses to render without it, so this fails loudly rather than starting a broken stack. |
| Docker reachable as this user | `docker ps` | `sudo usermod -aG docker $USER`, then start a new login session |
| Sandbox image built | `docker image inspect salurai-sandbox:1` | `bun run sandbox:build` |

Image generation is the one feature that is *not* covered by the root `.env`:
`OPENROUTER_API_KEY` lives in `apps/api/.env`, and without it `generate_image`
is simply not registered. That is a silent absence by design, not a failure —
but it is why a fresh server can look fully deployed and still have no image
tool.

## Steps

Run every command from the repo root.

1. **Verify the working tree is green.**
   ```bash
   cd apps/api && bun test; cd ../..
   ```
   Compare against the known baseline: the 7 `sandbox.service` / `docker.ts`
   tests fail only when Docker is unreachable. Any *other* failure stops the
   deploy — report it and do not continue.

2. **Build and start.**
   ```bash
   docker compose up -d --build
   ```
   `--build` is not optional: without it compose reuses the previous image and
   "deployed" would silently mean "restarted the old code".

3. **Wait for the API to answer, then verify.**
   ```bash
   docker compose ps
   curl -fsS "http://localhost:${WEB_PORT:-8080}/api/meta" | head -c 200
   ```
   `/api/meta` proves three things at once: Caddy is up, the proxy reaches the
   API, and the API finished `ensureSchema()`.

4. **Report what shipped.** Give the user the URL, the short commit sha
   (`git rev-parse --short HEAD`), and the container status — not just "done".

## Verifying a feature actually deployed

A green `docker compose ps` means the containers started, not that the new code
is in them. When the deploy exists to ship a specific feature, prove that
feature:

- New API route → `curl` it through `http://localhost:${WEB_PORT}/api/...`
- New UI → say which tab or control to open; do not claim it renders unless you
  looked
- Schema change → `docker compose logs api | grep -i schema` and confirm no
  migration error

## If it fails

| Symptom | Cause | Fix |
| --- | --- | --- |
| `permission denied ... docker.sock` | User not in `docker` group, or the shell predates the change | New login session; `sg docker -c '<command>'` as a stopgap |
| `SANDBOX_ROOT: unset` / `REPO_ROOT: unset` | `.env` missing or incomplete | `cp .env.example .env` and fill it in |
| Web up, `/api/*` returns 502 | API container crashed on boot | `docker compose logs api --tail 50` |
| Agent runs fail with "Docker isn't reachable" | Socket mounted but `DOCKER_GID` is wrong | `getent group docker \| cut -d: -f3`, set `DOCKER_GID` in `.env`, redeploy |
| Sandbox run fails on a missing workspace path | `SANDBOX_ROOT` or `REPO_ROOT` differ between host and container | Both must be the *same absolute path* on both sides — see the comments in `docker-compose.yml` |
| Port already allocated | Something else holds `WEB_PORT` | `ss -tlnp \| grep <port>`, then change `WEB_PORT` in `.env` |

## Rollback

Images are tagged per build, not per release, so rollback is by source:

```bash
git stash            # or: git checkout <last-good-sha>
docker compose up -d --build
```

The SQLite database is bind-mounted from `apps/api/data` and survives every
rebuild — rolling code back does **not** roll data back. A deploy that migrated
the schema forward may leave rows the older code cannot read.

## What deploy does not do

- No database backup. Take one yourself before a schema change:
  `cp apps/api/data/app.db apps/api/data/app.db.bak`
- No zero-downtime. `up -d` replaces containers; requests in flight are dropped.
- No authentication is added. The stack has none — do not publish `WEB_PORT`
  beyond a trusted network.
