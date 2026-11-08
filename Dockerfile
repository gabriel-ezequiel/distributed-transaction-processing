
# ==================================================
# Base
# ==================================================
FROM oven/bun:1 AS base

WORKDIR /app

# ==================================================
# Development
# ==================================================
FROM base AS development

COPY package.json bun.lock ./

RUN bun install --frozen-lockfile

COPY . .

EXPOSE 3000

CMD ["bun", "run", "start:dev"]

# ==================================================
# Build
# ==================================================
FROM base AS build

COPY package.json bun.lock ./

RUN bun install --frozen-lockfile

COPY . .

RUN bun run build

# ==================================================
# Production dependencies
# ==================================================
FROM base AS production-deps

COPY package.json bun.lock ./

RUN bun install --production --frozen-lockfile

# ==================================================
# Production
# ==================================================
FROM base AS production

ENV NODE_ENV=production

COPY --from=production-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

EXPOSE 3000

CMD ["bun", "run", "dist/main.js"]
