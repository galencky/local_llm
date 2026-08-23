# syntax=docker/dockerfile:1

# Project Airlock — container image for the Mac Mini.
#
# NOTE: LM Studio is NOT in here and must not be. Docker Desktop on macOS runs
# a Linux VM with no GPU passthrough, so a containerised model loses Metal/MLX
# acceleration entirely. It stays on the host; the container reaches it at
# host.docker.internal:1234.

FROM node:24-alpine AS base
WORKDIR /app
# Prisma 7 with a driver adapter needs no native query engine, so Alpine/musl
# is safe here — but openssl is still wanted by the toolchain.
RUN apk add --no-cache openssl

# ---------- dependencies ----------
FROM base AS deps
COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN npm ci --ignore-scripts

# ---------- build ----------
FROM base AS builder
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate && npm run build

# ---------- runtime ----------
FROM base AS runner
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

RUN addgroup -g 1001 -S nodejs && adduser -S airlock -u 1001

COPY --from=builder /app/public ./public
COPY --from=builder --chown=airlock:nodejs /app/.next/standalone ./
COPY --from=builder --chown=airlock:nodejs /app/.next/static ./.next/static

# The RSA keypair lives here and MUST be on a volume: a regenerated key breaks
# decryption for every browser tab still holding the old public key.
RUN mkdir -p /app/.keys && chown airlock:nodejs /app/.keys
VOLUME ["/app/.keys"]

USER airlock
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
