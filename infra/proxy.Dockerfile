# syntax=docker/dockerfile:1
# Reverse proxy + static web app. Build context = repo root:
#   docker build -f infra/proxy.Dockerfile --build-arg VITE_BASE_PATH=/ .
# VITE_BASE_PATH is the public sub-path with a trailing slash ("/" at the root,
# "/dental/" for https://example.com/dental). Multi-arch (arm64 + amd64).

FROM node:22-slim AS build
RUN npm install -g pnpm@9.15.0
WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @dcad/web...

COPY packages/shared packages/shared
COPY apps/web apps/web
ARG VITE_BASE_PATH=/
ENV VITE_BASE_PATH=${VITE_BASE_PATH}
RUN pnpm --filter @dcad/web exec vite build

FROM caddy:2
COPY infra/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/apps/web/dist /srv
