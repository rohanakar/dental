# Dev only: a local Opus 5.5 behind the Anthropic Messages API, answered by `claude -p` (see README.md).
# Build context: tools/claude-bridge. Auth: CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) or ANTHROPIC_API_KEY.
FROM node:22-slim

RUN npm i -g @anthropic-ai/claude-code && npm cache clean --force

WORKDIR /app
COPY package.json ./
COPY src ./src

ENV NODE_ENV=production \
    DISABLE_AUTOUPDATER=1 \
    CLAUDE_BRIDGE_HOST=0.0.0.0 \
    CLAUDE_BRIDGE_PORT=8787
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD ["node", "-e", "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", "src/main.ts"]
