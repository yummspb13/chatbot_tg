# Environment Variables для Vercel

## Обязательные переменные

### Для бота Telegram
```
TELEGRAM_BOT_TOKEN=ваш_токен_бота
TELEGRAM_ADMIN_CHAT_ID=ваш_telegram_id
```

### Для OpenAI
```
OPENAI_API_KEY=ваш_openai_ключ
OPENAI_MODEL=gpt-4o-mini (опционально, по умолчанию)
```

### Для базы данных
```
DATABASE_URL=строка_подключения_к_бд
```
Пример для SQLite (локально):
```
DATABASE_URL="file:./prisma/dev.db"
```
Пример для Postgres (продакшен):
```
DATABASE_URL="postgresql://user:password@host:5432/dbname?sslmode=require"
```

### Для API Афиши
```
Afisha_API_URL=https://kiddeo.vercel.app
Afisha_API_KEY=ваш_ключ_афиши
```

### Для админ-панели
```
ADMIN_USERNAME=admin
ADMIN_PASSWORD_HASH=хеш_пароля_сгенерированный_через_скрипт
JWT_SECRET=случайная_длинная_строка_для_jwt_токенов
```

### Для воркера (URL)
```
NEXT_PUBLIC_WORKER_URL=https://chatbot-tg.onrender.com
```

---

## Опциональные переменные

### Для публикации в группу
```
TELEGRAM_PUBLISH_GROUP_ID=id_группы_telegram
```

### Для окружения
```
NODE_ENV=production
```

---

## Как добавить в Vercel

1. Откройте проект в [Vercel Dashboard](https://vercel.com/dashboard)
2. Перейдите в **Settings** → **Environment Variables**
3. Нажмите **Add New**
4. Для каждой переменной:
   - **Name:** название переменной
   - **Value:** значение
   - **Environment:** выберите все (Production, Preview, Development)
5. Сохраните

**Важно для `NEXT_PUBLIC_*`:**
- Эти переменные доступны в браузере
- Обязательно выберите все окружения (Production, Preview, Development)

---

## Генерация значений

### Хеш пароля админа
```bash
npm run admin:password-hash "ваш_пароль"
```

### JWT Secret
```bash
# Сгенерируйте случайную строку
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Или используйте любой генератор случайных строк (минимум 32 символа).

---

## Проверка

После добавления всех переменных:
1. Перезапустите деплой в Vercel
2. Проверьте логи на наличие ошибок
3. Откройте админ-панель и проверьте работу

---

## Пример полного списка

```
# Telegram
TELEGRAM_BOT_TOKEN=1234567890:ABCdefGHIjklMNOpqrsTUVwxyz
TELEGRAM_ADMIN_CHAT_ID=123456789
TELEGRAM_PUBLISH_GROUP_ID=-1001234567890

# OpenAI
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini

# Database
DATABASE_URL=postgresql://user:pass@host:5432/db?sslmode=require

# Afisha API
Afisha_API_URL=https://kiddeo.vercel.app
Afisha_API_KEY=ваш_ключ

# Admin Panel
ADMIN_USERNAME=admin
ADMIN_PASSWORD_HASH=$2a$10$хеш_пароля
JWT_SECRET=случайная_длинная_строка_минимум_32_символа

# Worker
NEXT_PUBLIC_WORKER_URL=https://chatbot-tg.onrender.com

# Environment
NODE_ENV=production
```

