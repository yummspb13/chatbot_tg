# Настройка переменных окружения

Создайте файл `.env` в корне проекта со следующими переменными:

```env
# Telegram Bot Configuration
TELEGRAM_BOT_TOKEN=your_telegram_bot_token_here
TELEGRAM_ADMIN_CHAT_ID=your_admin_chat_id_here

# OpenAI Configuration
OPENAI_API_KEY=your_openai_api_key_here
OPENAI_MODEL=gpt-4o-mini

# Afisha API Configuration
BOT_API_KEY=17d38eb4c014c524e52675ab75661f0dcc8768cbc749a62e7309fabe6c9905cd
AFISHA_DRAFT_URL=https://kiddeo.vercel.app/api/bot/events/draft

# Database Configuration
# For SQLite (development):
DATABASE_URL="file:./dev.db"
# For Postgres (production):
# DATABASE_URL="postgresql://user:password@localhost:5432/afisha_bot?schema=public"
```

## Как получить значения:

1. **TELEGRAM_BOT_TOKEN**: Создайте бота через [@BotFather](https://t.me/botfather) в Telegram
2. **TELEGRAM_ADMIN_CHAT_ID**: Ваш Telegram user ID (можно узнать через [@userinfobot](https://t.me/userinfobot))
3. **OPENAI_API_KEY**: Получите на [platform.openai.com](https://platform.openai.com/api-keys)
4. **BOT_API_KEY**: Уже указан в примере (из документации API)
5. **AFISHA_DRAFT_URL**: Уже указан в примере
6. **DATABASE_URL**: Для разработки используйте SQLite, для продакшена - Postgres

