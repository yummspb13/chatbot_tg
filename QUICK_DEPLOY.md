# ⚡ Быстрый деплой на Vercel

## 🚀 Шаги деплоя

### 1. Установите переменные окружения в Vercel

Vercel Dashboard → Settings → Environment Variables

**Обязательные:**
```
AI_PROVIDER=openai
OPENAI_API_KEY=sk-...
TELEGRAM_BOT_TOKEN=8308554753:AAGs1rgn2EBwgLtZJYV0a7M8KKhndIOvKro
TELEGRAM_ADMIN_CHAT_ID=120352240
TELEGRAM_PUBLISH_GROUP_ID=-4993347411
DATABASE_URL=postgresql://...
ADMIN_PASSWORD_HASH=$2a$10$... (npm run admin:password-hash)
JWT_SECRET=... (минимум 32 символа)
```

**Полный список:** `VERCEL_ENV_SETUP.md`

### 2. Деплой

```bash
git add .
git commit -m "Production deployment with OpenAI"
git push
```

Или через Vercel Dashboard → Deploy

### 3. После деплоя - установите webhook

```bash
npm run webhook:set:prod https://your-app.vercel.app
```

### 4. Проверьте

```bash
npm run webhook:check
```

### 5. Тестируйте

1. Отправьте сообщение в канал
2. Проверьте группу - должна прийти карточка
3. Нажмите "Принять" или "Отказать"
4. Проверьте логи Vercel - должно быть `🤖 AI Provider: OPENAI`

## ⚠️ Важно

- `AI_PROVIDER=openai` (НЕ `mock`!)
- Webhook установить ПОСЛЕ деплоя
- Проверить, что `OPENAI_API_KEY` валиден

## 📚 Подробности

- `PRE_DEPLOY_CHECKLIST.md` - полный чеклист
- `DEPLOY_PRODUCTION.md` - детальная инструкция
- `VERCEL_ENV_SETUP.md` - все переменные окружения

