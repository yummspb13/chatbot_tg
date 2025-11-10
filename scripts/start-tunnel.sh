#!/bin/bash
# Скрипт для запуска туннеля с автоматической установкой webhook

echo "🔍 Проверяю доступные туннели..."

if command -v cloudflared &> /dev/null; then
    echo "✅ Найден cloudflared"
    echo "🚀 Запускаю туннель..."
    cloudflared tunnel --url http://localhost:3002 &
    TUNNEL_PID=$!
    sleep 3
    echo "⏳ Ожидаю публичный URL..."
    # cloudflared выводит URL в stdout, нужно его перехватить
    echo "⚠️  Скопируйте URL из вывода cloudflared и запустите:"
    echo "   npm run webhook:set <URL>/api/tg/webhook"
elif command -v ngrok &> /dev/null; then
    echo "✅ Найден ngrok"
    echo "🚀 Запускаю туннель..."
    ngrok http 3002 &
    TUNNEL_PID=$!
    sleep 3
    echo "⏳ Ожидаю публичный URL..."
    echo "⚠️  Скопируйте URL из вывода ngrok и запустите:"
    echo "   npm run webhook:set <URL>/api/tg/webhook"
else
    echo "❌ Не найден ни cloudflared, ни ngrok"
    echo ""
    echo "📦 Установите один из них:"
    echo "   brew install ngrok"
    echo "   или"
    echo "   brew install cloudflared"
    exit 1
fi
