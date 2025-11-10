FROM node:20-alpine

WORKDIR /app

# Копируем package.json и устанавливаем зависимости
COPY package*.json ./
RUN npm ci --only=production

# Копируем исходный код
COPY . .

# Собираем проект
RUN npm run build

# Запускаем воркер
CMD ["npm", "start"]

