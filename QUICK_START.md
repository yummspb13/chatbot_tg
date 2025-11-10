# 🚀 Быстрый старт

## Настройка Webhook для Telegram

### Вариант 1: С ngrok (автоматически)

1. **Установите ngrok:**
   ```bash
   # Если есть Homebrew:
   brew install ngrok
   
   # Или скачайте с https://ngrok.com/download
   ```

2. **Запустите автоматическую настройку:**
   ```bash
   bash scripts/setup-webhook-with-ngrok.sh
   ```

### Вариант 2: Вручную

1. **Запустите ngrok в отдельном терминале:**
   ```bash
   ngrok http 3002
   ```

2. **Скопируйте HTTPS URL** (например: `https://abc123.ngrok.io`)

3. **Установите webhook:**
   ```bash
   npm run webhook:set https://abc123.ngrok.io/api/tg/webhook
   ```

4. **Проверьте статус:**
   ```bash
   npm run webhook:info
   ```

### Вариант 3: Для продакшена (Vercel)

После деплоя:
```bash
npm run webhook:set https://your-app.vercel.app/api/tg/webhook
```

## Использование бота

1. **Запустите сервер** (если еще не запущен):
   ```bash
   npm run dev
   ```

2. **Откройте бота в Telegram** и отправьте:
   - `/start` - запуск бота
   - `/status` - проверка статуса
   - `/addcity Москва` - добавление города
   - `/addchannel moskva <chat_id> "Название"` - добавление канала

## Полезные команды

```bash
# Проверить webhook
npm run webhook:info

# Установить webhook
npm run webhook:set <url>

# Удалить webhook (вернуться к polling)
curl -X POST "https://api.telegram.org/bot<TOKEN>/deleteWebhook"
```

