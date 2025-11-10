#!/bin/bash
# Скрипт для установки ngrok без Homebrew

echo "📦 Установка ngrok..."

# Определяем архитектуру
ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ]; then
    ARCH="arm64"
elif [ "$ARCH" = "x86_64" ]; then
    ARCH="amd64"
else
    echo "❌ Неподдерживаемая архитектура: $ARCH"
    exit 1
fi

NGROK_DIR="$HOME/ngrok"
NGROK_BIN="$NGROK_DIR/ngrok"

# Создаем директорию
mkdir -p "$NGROK_DIR"

echo "📥 Скачиваю ngrok для macOS ($ARCH)..."

# Скачиваем ngrok
curl -L "https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-darwin-${ARCH}.zip" -o /tmp/ngrok.zip

if [ $? -ne 0 ]; then
    echo "❌ Ошибка при скачивании ngrok"
    echo ""
    echo "📋 Альтернатива: скачайте вручную:"
    echo "   1. Откройте https://ngrok.com/download"
    echo "   2. Скачайте для macOS"
    echo "   3. Распакуйте и переместите в ~/ngrok/"
    exit 1
fi

echo "📦 Распаковываю..."
cd /tmp
unzip -q ngrok.zip -d "$NGROK_DIR" 2>/dev/null || {
    echo "❌ Ошибка при распаковке"
    echo "💡 Попробуйте скачать вручную с https://ngrok.com/download"
    exit 1
}

chmod +x "$NGROK_BIN"

echo "✅ ngrok установлен в $NGROK_BIN"
echo ""
echo "🔧 Добавьте в PATH (добавьте в ~/.zshrc):"
echo "   export PATH=\"\$HOME/ngrok:\$PATH\""
echo ""
echo "Или используйте напрямую:"
echo "   ~/ngrok/ngrok http 3002"

