# Container image for salesforce-metadata-mcp.
#
# Deliberately builds from the source in this repo rather than installing a published version. That
# is the whole reason this file needs no per-release maintenance: it never names a version, so it
# cannot drift out of sync with package.json. `scripts/check-release-sync.mjs` enforces this by
# failing if anyone reintroduces a pinned `salesforce-metadata-mcp@x.y.z` here.
#
# This server speaks MCP over stdio, so the container is not a long-running service — an MCP client
# starts it and drives it through stdin/stdout. Run it interactively:
#
#   docker build -t salesforce-metadata-mcp .
#   docker run -i --rm \
#     -e SF_INSTANCE_URL="https://your-org.my.salesforce.com" \
#     -e SF_ACCESS_TOKEN="your-token" \
#     salesforce-metadata-mcp
#
# In an MCP client config, use "command": "docker" with those args. Note the SF CLI's browser-based
# login cannot work in a headless container, so SF_ALIAS is not usable here — pass credentials via
# the token, JWT, refresh-token, or client-credentials environment variables instead.

# ─── Build stage ──────────────────────────────────────────────────────────────
FROM node:22-alpine AS build

WORKDIR /app

# Copy manifests first so the dependency layer is cached independently of source edits.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ─── Runtime stage ────────────────────────────────────────────────────────────
FROM node:22-alpine

# tini reaps zombies and forwards signals. Without an init, a stdio server killed by its MCP client
# can leave orphaned child processes behind (this server spawns the `sf` CLI for some tools).
RUN apk add --no-cache tini

WORKDIR /app
ENV NODE_ENV=production

# Production dependencies only — the build stage's devDependencies (typescript et al) are discarded
# with that stage, keeping the runtime image small and its attack surface smaller.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# Never run as root. The node image ships an unprivileged `node` user; the app needs read-only access
# to /app and nothing else, so no ownership change is required.
USER node

ENTRYPOINT ["/sbin/tini", "--", "node", "dist/index.js"]
