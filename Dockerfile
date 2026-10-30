# Prisma only needs a syntactically valid URL to generate the client.
ARG BUILD_DATABASE_URL="postgresql://build:build@localhost:5432/build"

FROM node:22-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable \
  && apt-get update -y \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Production dependencies only, with the Prisma client generated and the migration engine downloaded.
FROM base AS prod-deps
ARG BUILD_DATABASE_URL
COPY package.json pnpm-lock.yaml prisma.config.ts ./
COPY prisma ./prisma
RUN pnpm install --frozen-lockfile --prod \
  && DATABASE_URL="$BUILD_DATABASE_URL" pnpm exec prisma generate \
  && DATABASE_URL="$BUILD_DATABASE_URL" pnpm exec prisma --version

# Full install to compile TypeScript.
FROM base AS build
ARG BUILD_DATABASE_URL
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN DATABASE_URL="$BUILD_DATABASE_URL" pnpm exec prisma generate && pnpm build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json prisma.config.ts ./
COPY prisma ./prisma
RUN chown -R node:node /app
USER node

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Apply pending migrations, then start the server.
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && exec node dist/main.js"]
