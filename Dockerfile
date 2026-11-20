# syntax=docker/dockerfile:1
# Coolify(Dockerfile ビルド)用。フロントを Vite でビルドし、Express で配信する。

FROM node:24-bookworm-slim AS build
WORKDIR /app
# Docker のブリッジ網には IPv6 経路が無いため、IPv4 を優先して npm の取得失敗を防ぐ
ENV NODE_OPTIONS=--dns-result-order=ipv4first \
    npm_config_fetch_retries=5 \
    npm_config_fetch_retry_mintimeout=20000 \
    npm_config_fetch_retry_maxtimeout=120000 \
    npm_config_maxsockets=4 \
    npm_config_audit=false \
    npm_config_fund=false
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NODE_OPTIONS=--dns-result-order=ipv4first \
    PORT=3000 \
    npm_config_fetch_retries=5 \
    npm_config_audit=false \
    npm_config_fund=false
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "server/index.js"]
