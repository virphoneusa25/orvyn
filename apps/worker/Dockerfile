FROM node:20-slim

# Install Docker CLI (the worker spawns mission containers as siblings
# via the host daemon — the CLI is needed, but mission containers NEVER
# get the socket)
RUN apt-get update -qq && apt-get install -y -qq docker.io && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install ALL deps (including typescript for compilation). The OpenShell SDK
# is vendored (built from the pinned v0.1.2 tag; its registry needs a token).
COPY apps/worker/package.json ./
COPY apps/worker/vendor/ ./vendor/
RUN npm install

# Copy source and build
COPY apps/worker/tsconfig.json ./
COPY apps/worker/src/ ./src/
RUN npx tsc -p tsconfig.json && rm -f dist/sandbox/*.test.js dist/sandbox/*.test.d.ts

# The production deploy runs this against the real gateway before it enables
# provider selection, so an upgrade can never inherit an older pass result.
COPY scripts/acceptance/openshell-sandbox.mjs ./acceptance/openshell-sandbox.mjs

# Reviewed network policy templates (the only policies a sandbox can get).
COPY apps/worker/sandbox-policies/ ./sandbox-policies/

# Remove devDependencies (keep only what's needed at runtime)
RUN npm prune --production

# Run the worker
CMD ["node", "dist/index.js"]
