#!/bin/bash

# Скрипт для настройки локального webhook через cloudflared
# Использование: ./scripts/setup-local-webhook.sh

echo "🔧 Настройка локального webhook через cloudflared..."

# Проверяем, установлен ли cloudflared
if ! command -v cloudflared &> /dev/null; then
    echo "❌ cloudflared не установлен"
    echo "Установите: brew install cloudflared"
    exit 1
fi

# Запускаем туннель в фоне
echo "🚇 Запускаю cloudflared туннель..."
cloudflared tunnel --url http://localhost:3000 > /tmp/cloudflared.log 2>&1 &
CLOUDFLARED_PID=$!
echo $CLOUDFLARED_PID > /tmp/cloudflared.pid

# Ждем, пока туннель запустится
sleep 3

# Получаем URL из логов
TUNNEL_URL=$(grep -o 'https://[^ ]*\.trycloudflare\.com' /tmp/cloudflared.log | head -1)

if [ -z "$TUNNEL_URL" ]; then
    echo "❌ Не удалось получить URL туннеля"
    echo "Логи:"
    cat /tmp/cloudflared.log
    kill $CLOUDFLARED_PID 2>/dev/null
    exit 1
fi

WEBHOOK_URL="${TUNNEL_URL}/api/tg/webhook"
echo "✅ Туннель запущен: $TUNNEL_URL"
echo "📋 Webhook URL: $WEBHOOK_URL"

# Загружаем переменные окружения
source .env 2>/dev/null || true

if [ -z "$TELEGRAM_BOT_TOKEN" ]; then
    echo "❌ TELEGRAM_BOT_TOKEN не найден в .env"
    kill $CLOUDFLARED_PID 2>/dev/null
    exit 1
fi

# Устанавливаем webhook
echo "🔧 Устанавливаю webhook..."
RESPONSE=$(curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -H "Content-Type: application/json" \
  -d "{
    \"url\": \"${WEBHOOK_URL}\",
    \"allowed_updates\": [\"message\", \"edited_message\", \"channel_post\", \"edited_channel_post\", \"callback_query\", \"inline_query\", \"chosen_inline_result\", \"poll\", \"poll_answer\", \"my_chat_member\", \"chat_member\", \"chat_join_request\"]
  }")

if echo "$RESPONSE" | grep -q '"ok":true'; then
    echo "✅ Webhook успешно установлен!"
    echo "📋 Ответ: $RESPONSE"
    echo ""
    echo "💡 Для остановки туннеля: kill \$(cat /tmp/cloudflared.pid)"
    echo "💡 Логи туннеля: tail -f /tmp/cloudflared.log"
else
    echo "❌ Ошибка при установке webhook: $RESPONSE"
    kill $CLOUDFLARED_PID 2>/dev/null
    exit 1
fi

