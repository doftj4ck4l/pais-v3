# The console: built to static files, then served by Caddy.
#
# Nothing from Bun survives into the runtime image — the output of `vite build`
# is plain files, and serving them from a 50MB Caddy image rather than a Bun one
# keeps the deployed surface to a web server.

FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
RUN bun install --frozen-lockfile

COPY apps/web ./apps/web
WORKDIR /app/apps/web
# `tsc -b && vite build` — the typecheck is deliberately inside the image build,
# so a type error fails the deploy instead of shipping.
RUN bun run build

FROM caddy:2-alpine
COPY apps/web/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/web/dist /srv
EXPOSE 8080
