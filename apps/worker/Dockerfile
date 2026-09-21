FROM node:20-slim

# Install Docker CLI (the worker spawns mission containers as siblings
# via the host daemon — the CLI is needed, but mission containers NEVER
# get the socket)
RUN apt-get update -qq && apt-get install -y -qq docker.io && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install ALL deps (including typescript for compilation)
COPY apps/worker/package.json ./
RUN npm install

# Copy source and build
COPY apps/worker/tsconfig.json ./
COPY apps/worker/src/ ./src/
RUN npx tsc -p tsconfig.json

# Remove devDependencies (keep only what's needed at runtime)
RUN npm prune --production

# Run the worker
CMD ["node", "dist/index.js"]
