#!/bin/bash
# Запуск ngrok и автоматическая установка webhook

echo "🚀 Запускаю ngrok..."

# Запускаем ngrok в фоне
~/ngrok/ngrok http 3002 > /tmp/ngrok.log 2>&1 &
NGROK_PID=$!

echo "⏳ Ожидаю запуск ngrok (10 секунд)..."
sleep 10

# Получаем URL
NGROK_URL=$(curl -s http://localhost:4040/api/tunnels 2>/dev/null | grep -oE 'https://[a-zA-Z0-9-]+\.(ngrok-free\.app|ngrok\.io)' | head -1)

if [ -z "$NGROK_URL" ]; then
    echo "❌ Не удалось получить URL от ngrok"
    echo ""
    echo "📋 Возможные причины:"
    echo "   1. ngrok требует регистрации (бесплатно на https://ngrok.com)"
    echo "   2. Нужно добавить authtoken: ~/ngrok/ngrok config add-authtoken <token>"
    echo ""
    echo "💡 Альтернатива: откройте ngrok вручную в отдельном терминале:"
    echo "   ~/ngrok/ngrok http 3002"
    echo ""
    echo "   Затем скопируйте HTTPS URL и запустите:"
    echo "   npm run webhook:set <URL>/api/tg/webhook"
    kill $NGROK_PID 2>/dev/null
    exit 1
fi

echo "✅ Найден URL: $NGROK_URL"
echo ""
echo "🔧 Устанавливаю webhook..."

npm run webhook:set "${NGROK_URL}/api/tg/webhook"

echo ""
echo "✅ Готово! Webhook установлен."
echo ""
echo "⚠️  ВАЖНО: Не закрывайте ngrok! Оставьте его запущенным."
echo "   PID процесса: $NGROK_PID"
