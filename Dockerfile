# Minimal container packaging for DigestIT (DIG-32 spike). Unverified in this sandbox — no
# working docker/podman here to build+run it (see docs/packaging.md); reviewed by hand against
# the workspace layout instead. Runs the normal built app (apps/server/dist + node_modules), not
# the SEA binary — the container already provides the Node runtime, so there is nothing for the
# SEA build to save here.
#
# Does NOT change the server's bind behaviour: it still binds 127.0.0.1 only (see
# apps/server/src/serve.ts). That means `-p host:container` alone will NOT make it reachable —
# see docs/packaging.md for the trade-off (`--network host` on Linux, or run digest natively).

# ---- builder ------------------------------------------------------------
FROM node:24-alpine AS builder
WORKDIR /app
RUN corepack enable

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/explain/package.json packages/explain/package.json
COPY packages/ingest/package.json packages/ingest/package.json
RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY apps apps
COPY packages packages
COPY bin bin
RUN pnpm -r build

# ---- runtime --------------------------------------------------------------
FROM node:24-alpine AS runtime
RUN addgroup -S digestit && adduser -S digestit -G digestit
WORKDIR /app

# node_modules carries devDependencies too (tsc/vite/vitest) since this spike doesn't prune —
# `pnpm deploy` or `pnpm prune --prod` is a documented next step, see docs/packaging.md.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=builder /app/bin ./bin
COPY --from=builder /app/apps/server/dist ./apps/server/dist
COPY --from=builder /app/apps/server/package.json ./apps/server/package.json
COPY --from=builder /app/apps/web/dist ./apps/web/dist
COPY --from=builder /app/apps/web/package.json ./apps/web/package.json
COPY --from=builder /app/packages/core/dist ./packages/core/dist
COPY --from=builder /app/packages/core/package.json ./packages/core/package.json
COPY --from=builder /app/packages/explain/dist ./packages/explain/dist
COPY --from=builder /app/packages/explain/package.json ./packages/explain/package.json
COPY --from=builder /app/packages/ingest/dist ./packages/ingest/dist
COPY --from=builder /app/packages/ingest/package.json ./packages/ingest/package.json

ENV NODE_ENV=production
ENV DIGESTIT_DB=/data/digestit.sqlite
# DIGESTIT_ALLOWED_HOSTS / DIGESTIT_TOKEN_FILE are intentionally not set here — pass them at
# `docker run` time (-e / --env-file). The token file must be bind-mounted (e.g. -v
# /host/token:/run/digestit-token:ro), never baked into the image or a layer.

VOLUME /data
USER digestit
ENTRYPOINT ["node", "bin/digest.js"]
CMD ["serve"]
