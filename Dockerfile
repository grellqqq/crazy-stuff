# ---- Build stage ----
FROM node:20-alpine AS build

WORKDIR /app

# Copy root workspace files
COPY package.json package-lock.json tsconfig.base.json ./

# Copy workspace package.json files first (for layer caching)
COPY src/client/package.json src/client/
COPY src/server/package.json src/server/

RUN npm ci

# Copy all source code
COPY src/ src/

# Build client (Vite) — outputs to src/client/dist/
RUN npm run build --workspace=src/client

# Build server (tsc) — outputs to src/server/dist/
RUN npm run build --workspace=src/server

# ---- Production stage ----
FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
COPY src/client/package.json src/client/
COPY src/server/package.json src/server/

RUN npm ci --omit=dev

# Copy built server
COPY --from=build /app/src/server/dist/ src/server/dist/

# Copy built client to where the server expects it
# Server __dirname = src/server/dist/server/src/, resolves ../../client/dist
COPY --from=build /app/src/client/dist/ src/server/dist/client/dist/

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "src/server/dist/server/src/index.js"]
