# apps/backend/Dockerfile
# Multi-stage build so the runtime image doesn't carry devDependencies or
# the TypeScript compiler. Build context must be the monorepo root, e.g.:
#   docker build -f apps/backend/Dockerfile -t orvyn-backend .
# Node >= 22.13 required: LocalStore/AuthService use node:sqlite (unflagged
# from 22.13; absent in Node 20 — the container would crash on boot).
FROM node:22-slim AS build
WORKDIR /repo

# ai-core is a workspace dependency of the backend — copy both.
COPY package.json ./
COPY packages/ai-core/package.json packages/ai-core/
COPY apps/backend/package.json apps/backend/

# --ignore-scripts: the root postinstall builds ai-core, but sources aren't
# copied yet at this layer — the explicit build steps below handle it.
RUN npm install --workspaces --no-audit --no-fund --ignore-scripts

COPY packages/ai-core packages/ai-core
COPY apps/backend apps/backend

RUN npm run build -w packages/ai-core
RUN npm run build -w apps/backend
# deploy-ovh.sh writes build-info.json (commit + time); local builds get "{}".
RUN test -f apps/backend/build-info.json || echo '{}' > apps/backend/build-info.json

# Playwright: install the npm package + Chromium in the build stage so the
# runtime image carries them (browserTools.ts does a runtime require).
# PLAYWRIGHT_BROWSERS_PATH forces a known location we can copy from.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN cd apps/backend && npm install playwright --no-save && cd /repo
RUN npx playwright install chromium --with-deps

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4570

# git: checkpoints and git tools shell out to it. docker CLI: the sandbox
# module spawns per-mission containers as siblings on the host daemon
# (socket mounted by compose), so mission code never runs on the API
# container itself.
COPY --from=docker:27-cli /usr/local/bin/docker /usr/local/bin/docker
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages/ai-core ./packages/ai-core
COPY --from=build /repo/apps/backend/dist ./dist
COPY --from=build /repo/apps/backend/package.json ./package.json
COPY --from=build /repo/apps/backend/build-info.json ./build-info.json
# Packaged skills. The process cwd is /app, and the loader looks for resources/skills there.
COPY resources/skills ./resources/skills

# Playwright + Chromium from the build stage.
COPY --from=build /ms-playwright /ms-playwright
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Chromium headless-shell runtime libraries.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
    libgbm1 libpango-1.0-0 libcairo2 libasound2 libatspi2.0-0 \
  && rm -rf /var/lib/apt/lists/*

EXPOSE 4570
CMD ["node", "dist/index.js"]
