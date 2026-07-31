# FX Agent — контейнер для Amvera/любого докер-хостинга.
# Долгоживущий Node-процесс: движок + Telegram + PWA на одном порту.
FROM node:20-slim

# openssl нужен Prisma
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# сначала зависимости (кэш слоёв), prisma generate идёт postinstall'ом
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --no-audit --no-fund

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["npm", "start"]
