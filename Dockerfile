# syntax=docker/dockerfile:1
#
# Standalone email gateway image. Independent of the monorepo image — its own
# node_modules + its own MySQL database. Shared by TrustList, Rutba Suite, etc.

FROM node:22-bookworm-slim AS base
WORKDIR /app
ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

# Install production deps only (cache on manifest).
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

EXPOSE 8025

# Healthcheck hits /health (DB ping).
HEALTHCHECK --interval=15s --timeout=5s --retries=10 --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.MAILER_PORT||8025)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
