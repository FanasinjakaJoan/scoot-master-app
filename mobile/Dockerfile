# Scoot Master — application web (build Expo « web » + serveur statique/proxy)
# Contexte de build : RACINE du dépôt (le serveur réutilise deploy/web-server.js)
#   docker build -f mobile/Dockerfile -t scoot-master-web .

# ---------- Étape 1 : build du bundle web ----------
FROM node:22-alpine AS build
WORKDIR /app

COPY mobile/package*.json ./mobile/
RUN npm ci --prefix mobile --no-audit --no-fund

COPY mobile ./mobile
# URL d'API vide ⇒ chemins relatifs : l'app appelle /api/* sur la même origine,
# le serveur web (étape 2) relaie vers le backend. Aucun CORS à configurer.
ARG EXPO_PUBLIC_API_URL=""
ENV EXPO_PUBLIC_API_URL=$EXPO_PUBLIC_API_URL \
    CI=1 \
    EXPO_NO_TELEMETRY=1
RUN npm ci --prefix mobile --no-audit --no-fund && \
    npx --prefix mobile expo export --platform web --output-dir mobile/dist

# ---------- Étape 2 : serveur statique + proxy /api ----------
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    WEB_ROOT=/app/dist \
    API_TARGET=http://api:4000

RUN addgroup -S scoot && adduser -S scoot -G scoot
COPY --from=build /app/mobile/dist ./dist
COPY deploy/web-server.js ./deploy/web-server.js
USER scoot

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/ >/dev/null || exit 1

CMD ["node", "deploy/web-server.js"]
