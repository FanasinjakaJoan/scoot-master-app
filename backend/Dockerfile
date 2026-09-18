# Scoot Master — API de synchronisation (image de production)
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

# Dépendances d'abord (cache Docker), puis le code.
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src

# L'application tourne avec un utilisateur non privilégié.
RUN addgroup -S scoot && adduser -S scoot -G scoot \
 && mkdir -p /app/data && chown -R scoot:scoot /app
USER scoot

# Base SQLite persistée via volume.
VOLUME /app/data
EXPOSE 4000

# Render injecte PORT=10000 par défaut — on utilise $PORT s'il est défini, sinon 4000.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD sh -c 'wget -qO- http://127.0.0.1:${PORT:-4000}/api/health || exit 1'

CMD ["node", "src/server.js"]
