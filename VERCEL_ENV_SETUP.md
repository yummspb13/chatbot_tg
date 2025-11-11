# 🔐 Переменные окружения для Vercel (Продакшен)

## 📋 Полный список переменных

Скопируйте и установите в Vercel Dashboard → Settings → Environment Variables

### 🤖 Telegram
```
TELEGRAM_BOT_TOKEN=8308554753:AAGs1rgn2EBwgLtZJYV0a7M8KKhndIOvKro
TELEGRAM_ADMIN_CHAT_ID=120352240
TELEGRAM_PUBLISH_GROUP_ID=-4993347411
```

### 🗄️ База данных
```
DATABASE_URL=postgresql://user:password@host:port/database?sslmode=require
```

### 🤖 AI (OpenAI для продакшена)
```
AI_PROVIDER=openai
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini
```

### 🔐 Админ панель
```
ADMIN_PASSWORD_HASH=$2a$10$... (сгенерировать через npm run admin:password-hash)
JWT_SECRET=your-secret-key-here (минимум 32 символа)
```

### 🔗 API ключи (опционально)
```
BOT_API_KEY=your-api-key-here
WORKER_API_KEY=your-worker-api-key-here
```

## ⚙️ Как установить

1. Откройте Vercel Dashboard
2. Выберите проект
3. Settings → Environment Variables
4. Добавьте каждую переменную:
   - Key: имя переменной
   - Value: значение
   - Environment: Production (и Preview, если нужно)

## ✅ Проверка после установки

После деплоя проверьте в логах Vercel:
- `🤖 AI Provider: OPENAI` (должно быть OPENAI, не MOCK)
- `✅ WEBHOOK: processed` (при тестовом сообщении)

## 🔄 После изменения переменных

После изменения переменных окружения нужно:
1. Передеплоить проект (Redeploy в Vercel)
2. Или подождать автоматического деплоя при следующем push

