# apps/backend/Dockerfile
# Multi-stage build so the runtime image doesn't carry devDependencies or
# the TypeScript compiler. Build context must be the monorepo root, e.g.:
#   docker build -f apps/backend/Dockerfile -t viride-backend .
FROM node:20-slim AS build
WORKDIR /repo

# ai-core is a workspace dependency of the backend — copy both.
COPY package.json ./
COPY packages/ai-core/package.json packages/ai-core/
COPY apps/backend/package.json apps/backend/

RUN npm install --workspaces --no-audit --no-fund

COPY packages/ai-core packages/ai-core
COPY apps/backend apps/backend

RUN npm run build -w packages/ai-core
RUN npm run build -w apps/backend

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4570

COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages/ai-core ./packages/ai-core
COPY --from=build /repo/apps/backend/dist ./dist
COPY --from=build /repo/apps/backend/package.json ./package.json

EXPOSE 4570
CMD ["node", "dist/index.js"]
