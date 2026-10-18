# syntax=docker/dockerfile:1.6
# Two-stage build for Charon.
#
# Stage 1: install all deps (including dev) and build the dist/.
# Stage 2: production deps only + dist/ from stage 1. No dev
# dependencies, no source tree, no migrations runner baked
# into the image — those run from CI / runtime config maps.

# ----- Stage 1: builder -------------------------------------------------
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Install OS deps the build needs (node-pg-migrate, node-gyp fallback).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      python3 \
      make \
      g++ \
 && rm -rf /var/lib/apt/lists/*

# Copy the manifest first so the dependency layer is cached
# separately from the source layer.
COPY package.json yarn.lock ./

# Install all deps (including dev). yarn install --frozen-lockfile
# matches the CI pipeline; the dev deps are needed for `nest build`.
RUN yarn install --frozen-lockfile --ignore-engines

# Copy the rest of the source.
COPY tsconfig*.json nest-cli.json ./
COPY src ./src
COPY test ./test
COPY migrations ./migrations

# Build dist/ (the compiled JS the runner image consumes).
RUN yarn build

# Drop dev deps so the prod layer is as small as possible.
RUN yarn install --frozen-lockfile --production --ignore-engines \
 && yarn cache clean

# ----- Stage 2: runner -------------------------------------------------
FROM node:22-bookworm-slim AS runner

WORKDIR /app

# Production-only deps and the compiled output.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/migrations ./migrations

# Run as a non-root user (the postgres client doesn't need root).
RUN groupadd --system --gid 1001 charon \
 && useradd  --system --uid 1001 --gid 1001 --no-create-home charon \
 && chown -R charon:charon /app
USER charon

# Healthcheck hits the liveness probe. The probe URL is
# `/healthz`; if the route is not yet implemented (stage 2
# not deployed), the healthcheck will fail and the container
# will be marked unhealthy — that's the correct behavior.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT||'3000') + '/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Production listens on loopback. The smoke step overrides
# with `HOST=0.0.0.0` at runtime (see CI smoke step).
ENV HOST=127.0.0.1
ENV PORT=3000
ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "dist/src/main.js"]
