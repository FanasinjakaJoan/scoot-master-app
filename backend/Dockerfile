# Scoot Master — API de synchronisation
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
VOLUME /app/data
EXPOSE 4000
CMD ["node", "src/server.js"]
