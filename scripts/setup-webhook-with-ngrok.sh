#!/bin/bash
# Автоматическая настройка webhook с ngrok

echo "🔍 Проверяю ngrok..."

if ! command -v ngrok &> /dev/null; then
    echo "❌ ngrok не найден!"
    echo ""
    echo "📦 Установите ngrok одним из способов:"
    echo ""
    echo "1. Через Homebrew:"
    echo "   brew install ngrok"
    echo ""
    echo "2. Скачайте с сайта:"
    echo "   https://ngrok.com/download"
    echo "   Затем добавьте в PATH"
    echo ""
    exit 1
fi

echo "✅ ngrok найден"
echo ""
echo "🚀 Запускаю ngrok туннель..."
echo "⚠️  Оставьте этот процесс запущенным в отдельном терминале!"
echo ""

# Запускаем ngrok в фоне и получаем URL
ngrok http 3002 > /tmp/ngrok.log 2>&1 &
NGROK_PID=$!

echo "⏳ Ожидаю запуск ngrok (5 секунд)..."
sleep 5

# Получаем URL из ngrok API
NGROK_URL=$(curl -s http://localhost:4040/api/tunnels | grep -o '"public_url":"https://[^"]*' | head -1 | cut -d'"' -f4)

if [ -z "$NGROK_URL" ]; then
    echo "❌ Не удалось получить URL от ngrok"
    echo "📋 Проверьте вывод ngrok вручную:"
    echo "   ngrok http 3002"
    echo ""
    echo "Затем скопируйте HTTPS URL и запустите:"
    echo "   npm run webhook:set <URL>/api/tg/webhook"
    kill $NGROK_PID 2>/dev/null
    exit 1
fi

echo "✅ Найден URL: $NGROK_URL"
echo ""
echo "🔧 Устанавливаю webhook..."

WEBHOOK_URL="${NGROK_URL}/api/tg/webhook"
npm run webhook:set "$WEBHOOK_URL"

echo ""
echo "✅ Готово! Webhook установлен на: $WEBHOOK_URL"
echo ""
echo "⚠️  ВАЖНО: Не закрывайте ngrok! Оставьте его запущенным."
echo "   Для остановки нажмите Ctrl+C в терминале с ngrok"

