# The web app (Next.js) as a container, for hosting later. Build context: the repository root (npm workspaces
# share one lockfile).
#   docker build -f apps/web/Dockerfile --build-arg API_PROXY_TARGET=http://lb .
FROM node:24-slim

WORKDIR /app

# 1. Dependencies first, from the manifests only: this layer is cached until a package.json or the lockfile changes.
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY services/booking-api/package.json services/booking-api/
COPY services/workers/package.json services/workers/
COPY services/ops/package.json services/ops/
RUN npm ci --workspace @ds/web --workspace @ds/shared --include-workspace-root --no-audit --no-fund

# 2. Source, then the production build.
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web

# Where /api/* is forwarded. Next.js bakes rewrites into the build, so this is a BUILD argument, not a runtime
# variable. Default: a load balancer named "lb" on the same container network (as in docker-compose).
ARG API_PROXY_TARGET=http://lb
ENV API_PROXY_TARGET=$API_PROXY_TARGET NEXT_TELEMETRY_DISABLED=1
RUN npm run build --workspace @ds/web

ENV NODE_ENV=production
# Hosting platforms set PORT (default 3000); `next start` listens on it (see apps/web/package.json).
CMD ["npm", "run", "start", "--workspace", "@ds/web"]
