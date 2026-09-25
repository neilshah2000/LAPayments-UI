# syntax=docker/dockerfile:1.7
#
# Build for the architecture you will run on. Two independent things are platform-keyed:
# the @duckdb/node-bindings native package, and the httpfs/aws extension binaries baked in
# the `ext` stage. An arm64 image on an x86_64 task fails twice, at different times.
#
#   docker build --platform=linux/arm64 -t lapayments-ui .
#
# and pair it with ECS runtimePlatform.cpuArchitecture: ARM64 (also ~20% cheaper).
#
# node:24-slim is Debian/glibc. @duckdb/node-bindings does publish -musl variants, so Alpine
# is worth trying; the open question is whether the httpfs/aws EXTENSION builds exist for
# musl at this DuckDB version. The `ext` stage fails the build if they don't.
# The `ext` stage downloads from extensions.duckdb.org, so THIS BUILD needs internet
# egress. That is the same trap as at runtime, moved to build time on purpose: if you
# later build in CodeBuild inside a private VPC, the build fails instead of the request.
ARG NODE=node:24-slim

# --- base: CA certificates -------------------------------------------------------------
# node:24-slim ships without ca-certificates. Node bundles its own CA store, so npm works
# regardless -- but DuckDB uses the SYSTEM store. Without this, the extension download
# fails in the `ext` stage AND every s3:// read fails at runtime, both as
# "Problem with the SSL CA cert". Needed in any stage that talks TLS through DuckDB.
FROM ${NODE} AS base
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# --- web: vite build ------------------------------------------------------------------
FROM ${NODE} AS web
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
# web/src/api.ts type-imports ../../src/api-types.ts, so the repo layout has to be mirrored.
COPY src/api-types.ts /app/src/api-types.ts
COPY web/ ./
RUN npm run build

# --- deps: server node_modules, built for THIS platform --------------------------------
FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# tsx was moved to "dependencies" because `npm start` is `tsx src/server.ts` -- with it
# still in devDependencies this --omit=dev would build an image that cannot boot. tsx
# bundles its own esbuild, so the typescript package is genuinely dev-only.
RUN npm ci --omit=dev

# --- ext: bake the DuckDB extensions ---------------------------------------------------
FROM deps AS ext
ENV DUCKDB_EXTENSION_DIR=/opt/duckdb-ext
COPY scripts/install-extensions.mjs ./scripts/
RUN node scripts/install-extensions.mjs

# --- runtime ----------------------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=ext  /opt/duckdb-ext   /opt/duckdb-ext
COPY --from=web  /app/web/dist     ./web/dist
COPY package.json tsconfig.json ./
COPY src/ ./src/

# The catalogue, baked in (README open decision #1). ECS has no bind mounts and these two
# CSVs are not in S3, so without them loadCatalogue() fails inside open() and the process
# dies before it can serve anything. Run scripts/stage-catalogue.sh first -- `npm run
# docker:build` does both. serving_files.csv here is only the fallback: the Express task sets
# LAP_REGISTERS_DIR to read it live from s3://…/registers/. councils_master.csv is not in S3,
# so the baked copy is the one served, and it is only as current as the last build.
COPY build/catalogue/ /app/catalogue/
ENV LAP_CATALOGUE_DIR=/app/catalogue

# DuckDB spills here under memory pressure; the default is ".tmp" relative to cwd, which
# breaks under readonlyRootFilesystem.
#
# With readonlyRootFilesystem: true, mount a writable volume at /tmp -- not just at
# /tmp/duckdb. tsx writes its compile cache to /tmp/tsx-<uid>, so a narrower mount fails at
# startup with: ENOENT: no such file or directory, mkdir '/tmp/tsx-1000'. Verified with
# `docker run --read-only --tmpfs /tmp:mode=1777`.
RUN mkdir -p /tmp/duckdb && chown -R node:node /tmp/duckdb

ENV DUCKDB_EXTENSION_DIR=/opt/duckdb-ext \
    LAP_TEMP_DIR=/tmp/duckdb \
    LAP_WEB_DIR=./web/dist \
    PORT=3000

# Set at deploy time; both default to the local data/ dir, which is not in this image:
#   LAP_DATA_DIR=s3://lapayments-<account-id>          serving/{la_code}.parquet joined on
#   LAP_CATALOGUE_DIR=s3://...                         if the two CSVs live elsewhere
#   LAP_REGISTERS_DIR=s3://.../registers               serving_files.csv alone, read live
#   LAP_MEMORY_LIMIT / LAP_THREADS                     match the task size; do not leave to detection
#   AWS_REGION                                         for the s3 secret

USER node
EXPOSE 3000
# node directly, not `npm start`: with npm as PID 1 the SIGTERM ECS sends on task stop is
# reported as a failure and the container exits 1, which shows up in ECS events as
# "Essential container exited with code 1" on every ordinary deploy. node as PID 1 receives
# the signal itself and exits 0. (`--import tsx` keeps the no-build-step setup.)
CMD ["node", "--import", "tsx", "src/server.ts"]

# Deploy target: ECS on Fargate. (App Runner is closed to new customers as of 2026; AWS
# points new work at ECS Express Mode, which provisions the Fargate service, ALB, auto
# scaling and networking from one create-express-gateway-service call.) Either way:
#   containerPort    3000
#   healthCheckPath  /api/health
#   health check grace period: size it against the boot warm in src/server.ts, which
#     profiles every council before the port opens and grows with the catalogue.
# Confirm Express Mode exposes a cpuArchitecture setting before relying on the ARM64
# build above; if it does not, rebuild with --platform=linux/amd64 (no file changes).
