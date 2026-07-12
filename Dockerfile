FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./
COPY public ./public

ENV NODE_ENV=production
EXPOSE 10000

CMD ["node", "server.js"]
