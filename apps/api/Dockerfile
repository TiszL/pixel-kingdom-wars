# Production image for the API.
#
# Built from the REPO ROOT, not this directory:
#     docker build -f apps/api/Dockerfile -t shardkeep-api .
# because the api depends on three workspace packages by source and a build
# context of apps/api alone cannot see them.
#
# WHY IT RUNS TYPESCRIPT DIRECTLY. `packages/{shared,sim,chain}` are consumed as
# TypeScript source (`"main": "./src/index.ts"`) — nothing in this repo emits
# JavaScript. Compiling ahead of time would mean adding a build step, output
# resolution and a source-map story to three packages, for a devnet alpha whose
# bottleneck is Postgres round-trips rather than a few hundred milliseconds of
# startup transpilation. So tsx is a real runtime dependency here, declared as
# one in package.json rather than smuggled in as a devDependency.
#
# Debian slim, not Alpine: `sharp` is a dependency (deed images) and its prebuilt
# binaries target glibc. On musl it either falls back to a slow build-from-source
# or fails outright, and the failure surfaces at request time rather than build
# time.

FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

# --- dependencies ----------------------------------------------------------
# Manifests first, in their own layer: they change far less often than source,
# so an edit to a route does not re-run a multi-minute install.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# pnpm verifies workspace patch hashes even for a filtered dependency install.
COPY patches ./patches
COPY apps/api/package.json      apps/api/
COPY packages/shared/package.json packages/shared/
COPY packages/sim/package.json    packages/sim/
COPY packages/chain/package.json  packages/chain/
COPY apps/web/package.json        apps/web/
COPY scripts/package.json         scripts/
# --frozen-lockfile: a deploy must install exactly what CI tested. If the
# lockfile is stale the build FAILS rather than silently resolving something new.
RUN pnpm install --frozen-lockfile --filter @shardkeep/api...

# --- runtime ---------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
# The signer uses an OS advisory lock held by a pipe-bound helper. Kernel lock
# release on container crash prevents both split-brain writes and stale-lock
# withdrawal outages; util-linux provides `flock` on Debian.
RUN apt-get update \
  && apt-get install -y --no-install-recommends util-linux \
  && command -v flock >/dev/null \
  && rm -rf /var/lib/apt/lists/*

# Build identity, surfaced by GET /version. Passed in by the deploy script; the
# defaults are honest markers rather than a plausible-looking lie.
ARG APP_VERSION=0.0.0-dev
ARG GIT_SHA=dev
ARG BUILD_TIME
ENV APP_VERSION=$APP_VERSION GIT_SHA=$GIT_SHA BUILD_TIME=$BUILD_TIME

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=deps /app/packages ./packages
COPY package.json pnpm-workspace.yaml ./
COPY packages ./packages
COPY apps/api ./apps/api
# The selected cluster's public registry is read at boot (program IDs, mints,
# treasuries). Today only devnet is tracked; a reviewed mainnet registry is
# automatically included by this exact suffix when it is deliberately added.
COPY infra/*.addresses.json ./infra/
# The generated texture atlases: game/baseRender.ts composites each player's
# Land Deed PNG from them at request time. Generated output (`pnpm assets`), so
# they exist on any machine that has built the web client; a build without them
# fails HERE rather than shipping an API whose every deed image 404s.
COPY apps/web/public/atlas ./apps/web/public/atlas
# deploy.sh runs with umask 077 so generated files can arrive as 0600/0700.
# Normalize this public, read-only input while still root: the internet-facing
# runtime may read deed-render assets, but an application compromise must not
# be able to rewrite the image's canonical atlas bytes in its writable layer.
RUN find /app/apps/web/public/atlas -type d -exec chmod 0555 {} + \
  && find /app/apps/web/public/atlas -type f -exec chmod 0444 {} +
ENV REPO_ROOT=/app

# Drop root. Nothing here needs it, and the process talks to the internet.
USER node

# Prove as the real runtime user—not root—that every public atlas object is
# readable/searchable but immutable before this image can exist. Symlinks are
# forbidden so the recursive mode/ownership proof cannot be bypassed.
RUN test -r /app/apps/web/public/atlas/meta.json \
  && [ -z "$(find /app/apps/web/public/atlas -type f ! -readable -print -quit)" ] \
  && [ -z "$(find /app/apps/web/public/atlas -type d ! -executable -print -quit)" ] \
  && [ -z "$(find /app/apps/web/public/atlas -type f -writable -print -quit)" ] \
  && [ -z "$(find /app/apps/web/public/atlas -type d -writable -print -quit)" ] \
  && [ -z "$(find /app/apps/web/public/atlas ! -user root -print -quit)" ] \
  && [ -z "$(find /app/apps/web/public/atlas -type l -print -quit)" ]

EXPOSE 3001
# Run FROM apps/api, not the repo root. pnpm does not hoist `tsx` to the root
# node_modules — it belongs to the api package — so `node --import tsx` started
# at /app cannot resolve it (ERR_MODULE_NOT_FOUND, caught by actually running
# this image rather than trusting it). This also matches the cwd the dev script
# assumes.
WORKDIR /app/apps/api
# server.ts already handles SIGTERM by draining in-flight requests and closing
# Postgres/Redis, so `docker stop` is a clean shutdown rather than a severed
# transaction. Exec form, so the signal actually reaches node as PID 1.
CMD ["node", "--import", "tsx", "src/server.ts"]
