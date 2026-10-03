# syntax=docker/dockerfile:1
# API image. Build context = repo root:
#   docker build -f infra/api.Dockerfile .
# Multi-arch: node:22-slim is published for linux/arm64 and linux/amd64, so this
# builds natively on the aarch64 OCI VM.

FROM node:22-slim AS build
RUN npm install -g pnpm@9.15.0
WORKDIR /repo

# Install dependencies first (cached unless manifests or the lockfile change).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @dcad/api...

COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @dcad/api build \
 && pnpm --filter @dcad/api deploy --prod /out

FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    BLOB_FS_ROOT=/data/blobs \
    MIGRATIONS_DIR=/app/drizzle
WORKDIR /app
COPY --from=build /out/package.json ./package.json
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/apps/api/dist ./dist
COPY --from=build /repo/apps/api/drizzle ./drizzle
RUN mkdir -p /data/blobs && chown -R node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "--max-old-space-size=768", "--enable-source-maps", "dist/main.js"]
