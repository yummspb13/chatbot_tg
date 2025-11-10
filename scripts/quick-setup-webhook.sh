#!/bin/bash
# Быстрая настройка webhook

echo "🚀 Запускаю ngrok..."
~/ngrok/ngrok http 3002 &
NGROK_PID=$!

echo "⏳ Ожидаю 10 секунд для запуска ngrok..."
sleep 10

# Пробуем получить URL разными способами
NGROK_URL=""

# Способ 1: через API
NGROK_URL=$(curl -s http://localhost:4040/api/tunnels 2>/dev/null | grep -oE 'https://[a-zA-Z0-9-]+\.(ngrok-free\.app|ngrok\.io|ngrok\.app)' | head -1)

# Способ 2: через sed
if [ -z "$NGROK_URL" ]; then
    NGROK_URL=$(curl -s http://localhost:4040/api/tunnels 2>/dev/null | sed -n 's/.*"public_url":"\(https:\/\/[^"]*\)".*/\1/p' | head -1)
fi

if [ -z "$NGROK_URL" ]; then
    echo "❌ Не удалось автоматически получить URL"
    echo ""
    echo "📋 Сделайте вручную:"
    echo "1. Откройте в браузере: http://localhost:4040"
    echo "2. Скопируйте HTTPS URL (например: https://abc123.ngrok-free.app)"
    echo "3. Запустите:"
    echo "   npm run webhook:set <URL>/api/tg/webhook"
    echo ""
    echo "Или проверьте вывод ngrok в терминале выше"
    exit 1
fi

echo "✅ Найден URL: $NGROK_URL"
echo ""
echo "🔧 Устанавливаю webhook..."

npm run webhook:set "${NGROK_URL}/api/tg/webhook"

echo ""
echo "✅ Webhook установлен!"
echo "📊 Проверяю статус..."
npm run webhook:info

echo ""
echo "⚠️  ВАЖНО: ngrok запущен в фоне (PID: $NGROK_PID)"
echo "   Не закрывайте этот процесс!"
