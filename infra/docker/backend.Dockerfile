# One image for every backend process: booking-api, workers, and the one-off jobs (migrate, seed, materialize,
# reindex, demo:reset). Each process is the same image with a different command. Build context: the repo root.
#   docker build -f infra/docker/backend.Dockerfile -t ds-backend .
#   booking-api (default):  docker run ds-backend
#   workers:                docker run ds-backend npm exec --workspace @ds/workers -- tsx src/index.ts
#   migrations:             docker run ds-backend npm run db:migrate
# Not tied to any host: configure it with the same variables as local (DATABASE_URL, REDIS_URL, KAFKA_BROKERS,
# OPENSEARCH_URL, API_URL, WEB_ORIGIN, HOST, API_PORT).
FROM node:24-slim

WORKDIR /app

# 1. Dependencies, from the manifests only (cached until a package.json or the lockfile changes).
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY services/booking-api/package.json services/booking-api/
COPY services/workers/package.json services/workers/
COPY services/ops/package.json services/ops/
# The root workspace is included: it carries tsx (we run TypeScript directly, decision D2) and pg for db/*.ts.
RUN npm ci --workspace @ds/booking-api --workspace @ds/workers --workspace @ds/shared --include-workspace-root \
      --no-audit --no-fund

# 2. Source. No build step: tsx compiles on start (about a second).
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY services/booking-api services/booking-api
COPY services/workers services/workers
COPY db db
COPY scripts scripts

ENV NODE_ENV=production
EXPOSE 4000
CMD ["npm", "run", "start", "--workspace", "@ds/booking-api"]
