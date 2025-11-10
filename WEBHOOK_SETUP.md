# Настройка Webhook для Telegram бота

## ⚠️ Важно для локальной разработки

Telegram не может достучаться до `localhost`. Для локальной разработки нужен **публичный URL**.

## Варианты решения:

### 1. Использовать ngrok (рекомендуется)

**Установка ngrok:**
```bash
# macOS
brew install ngrok

# Или скачать с https://ngrok.com/download
```

**Запуск туннеля:**
```bash
ngrok http 3002
```

**Установка webhook:**
```bash
npm run webhook:set https://<ваш-ngrok-url>/api/tg/webhook
```

### 2. Использовать cloudflared (альтернатива)

```bash
# Установка
brew install cloudflared

# Запуск туннеля
cloudflared tunnel --url http://localhost:3002
```

### 3. Для продакшена (Vercel)

После деплоя на Vercel:
```bash
npm run webhook:set https://your-app.vercel.app/api/tg/webhook
```

## Команды для управления webhook:

```bash
# Проверить текущий webhook
npm run webhook:info

# Установить webhook
npm run webhook:set <url>

# Удалить webhook (использовать polling вместо webhook)
curl -X POST "https://api.telegram.org/bot<TOKEN>/deleteWebhook"
```

## Текущий статус:

Webhook установлен на `http://localhost:3002/api/tg/webhook`, но **не будет работать** до тех пор, пока не будет использован публичный URL через ngrok или другой туннель.

