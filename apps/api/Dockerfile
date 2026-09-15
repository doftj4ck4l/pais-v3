# syntax=docker/dockerfile:1.7
#
# The API, plus a docker CLI.
#
# The CLI is not decoration: the agent's sandbox is a *sibling* container, and
# `services/sandbox/docker.ts` reaches the daemon by spawning `docker`, not
# through a library. With the host socket bind-mounted, this container asks the
# host daemon to start workspace containers next to it rather than inside it.
#
# That is also why several paths must be identical on both sides of the mount:
# `docker run -v <path>:<path>` is resolved by the *daemon*, so a workspace
# directory named by this container has to mean the same thing on the host.
# docker-compose.yml mounts SANDBOX_ROOT and SKILLS_ROOT at their host paths.
#
# Every external version is an ARG, pinned. A floating tag makes a rebuild a
# different image than the one that was tested, and the failure surfaces at run
# time rather than at build time.

ARG BUN_VERSION=1.3.14
ARG NODE_VERSION=22
ARG UV_VERSION=0.9.7
# Pinned to the host daemon's version. The CLI negotiates the API version, so a
# minor drift is survivable, but a pin makes a broken deploy obvious at build
# time rather than at the first sandbox run.
ARG DOCKER_CLI_VERSION=29.3.1

# ---------------------------------------------------------------------------
# deps — the API's production dependencies, and nothing else.
#
# `--filter '!./apps/web'` is the whole point. This is a workspace, so a plain
# `bun install` also resolves the console's toolchain — react, vite, tailwind,
# typescript, oxlint, rolldown — into the store, and every byte of it shipped in
# an image that never builds the frontend. `--production` then drops the API's
# own devDependencies (drizzle-kit, @types/bun), which the runtime never loads:
# Bun transpiles TypeScript directly, so there is no build step to serve.
# ---------------------------------------------------------------------------
FROM oven/bun:${BUN_VERSION} AS deps
WORKDIR /app
# odbc is an N-API addon. Keep its compiler, Python, and unixODBC headers in
# this build-only stage; none of them belong in the API runtime image.
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential python3 unixodbc-dev \
 && rm -rf /var/lib/apt/lists/*
# Manifests only, so a source edit does not invalidate the install layer.
# apps/web's manifest is copied but not installed — `--frozen-lockfile` verifies
# the lockfile against every workspace member, so omitting it fails the install.
COPY package.json bun.lock ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
RUN --mount=type=cache,target=/root/.bun/install/cache \
    npm_config_build_from_source=true \
    bun install --frozen-lockfile --production --filter '!./apps/web'

# Aliases, because only `FROM` expands a build ARG — `COPY --from=img:${VAR}`
# parses the reference before substitution and fails as an invalid name. Naming
# the stages here keeps every version pinned in one place at the top.
FROM node:${NODE_VERSION}-slim AS node
FROM ghcr.io/astral-sh/uv:${UV_VERSION} AS uv

# The official CLI image publishes both amd64 and arm64 variants. BuildKit
# selects the native binary, so there is no architecture-name mapping to drift.
FROM docker:${DOCKER_CLI_VERSION}-cli AS docker-cli

# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
FROM oven/bun:${BUN_VERSION} AS runtime
ARG NODE_VERSION
ARG UV_VERSION

# The Bun image ships no CA bundle, so without this every outbound HTTPS call —
# model providers, HTTP MCP servers — fails certificate verification. FFmpeg
# strips video and segments large recordings below model-gateway upload limits.
# Debian's default FreeTDS 1.3.x preserves doubled closing braces in ODBC
# passwords instead of decoding them. Pin the Debian backport that fixes the
# parser so an ASE password with `;`, `}`, or `=` authenticates correctly.
COPY apps/api/docker/trixie-backports.sources /etc/apt/sources.list.d/trixie-backports.sources
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates ffmpeg unixodbc \
    tdsodbc=1.5.5+ds-1~bpo13+1 freetds-common=1.5.5+ds-1~bpo13+1 \
 && rm -rf /var/lib/apt/lists/*

COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker

# Launchers for stdio MCP servers.
#
# A stdio server is a child of THIS process, so `services/mcp/allowlist.ts`
# permitting `uvx` means nothing unless `uvx` exists in this image. Copied from
# the official images rather than installed through apt: no third-party repo
# keys, and the version is whatever the tag says.
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -sf ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -sf ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
COPY --from=uv /uv /uvx /usr/local/bin/

# uvx and npx download packages on first use, and the MCP SDK only forwards a
# safe subset of environment variables to a child — HOME among them, but not
# UV_CACHE_DIR. So the cache location has to follow from HOME, which means HOME
# has to be a writable path for uid 1000. docker-compose mounts a volume here
# so a rebuild does not re-download every server.
ENV HOME=/cache
RUN mkdir -p /cache && chown 1000:1000 /cache

WORKDIR /app
# Both are load-bearing: the root holds Bun's package store, and the workspace
# directory holds the API's own symlinks into it. Without the second, every
# dependency declared in apps/api/package.json fails to resolve at run time.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY package.json bun.lock ./
COPY apps/api ./apps/api
# The version travels with the image, so a running container can report what it
# is (GET /api/meta) without any external env — see src/lib/version.ts.
COPY VERSION ./VERSION

# The API resolves its SQLite file as `cwd/data/app.db`, so cwd is part of the
# contract, not a convenience.
WORKDIR /app/apps/api
RUN mkdir -p data && chown 1000:1000 data

# docker-compose overrides this with the host's uid so bind-mounted files are
# owned by the host user. Declared anyway: `docker run` without compose should
# not default to root.
USER 1000:1000

EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["bun", "-e", "await fetch('http://127.0.0.1:4000/api/meta')"]
CMD ["bun", "src/index.ts"]
