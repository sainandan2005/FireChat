# ---- build stage ----
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY prisma ./prisma
COPY src ./src
COPY server ./server
COPY public ./public
COPY next.config.ts tsconfig.json postcss.config.mjs eslint.config.mjs prisma.config.ts ./

# placeholders satisfy env reads during build; no DB is contacted at build time
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build"
ENV JWT_SECRET="build-time-placeholder"
RUN npx prisma generate && npm run build

# ---- runtime stage ----
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN addgroup -S firechat && adduser -S firechat -G firechat

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/src ./src
COPY --from=builder /app/server ./server
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/next.config.ts ./next.config.ts
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/postcss.config.mjs ./postcss.config.mjs
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts

RUN mkdir -p uploads && chown -R firechat:firechat /app
USER firechat

EXPOSE 3000

CMD ["sh", "-c", "npx prisma migrate deploy && npx tsx server/index.ts"]
