# Деплой админ-панели на Vercel

## Что нужно для деплоя

### 1. GitHub репозиторий
✅ Уже есть: `yummspb13/chatbot_tg`

### 2. Переменные окружения

Нужно будет добавить в Vercel:

**Обязательные:**
- `NEXT_PUBLIC_WORKER_URL=https://chatbot-tg.onrender.com`
- `TELEGRAM_BOT_TOKEN` (токен бота)
- `TELEGRAM_ADMIN_CHAT_ID` (ваш Telegram ID)
- `OPENAI_API_KEY` (ключ OpenAI)
- `DATABASE_URL` (строка подключения к БД)
- `Afisha_API_URL` (URL API Афиши)
- `Afisha_API_KEY` (ключ API Афиши)

**Для админ-панели:**
- `ADMIN_USERNAME` (логин админа)
- `ADMIN_PASSWORD_HASH` (хеш пароля, см. ниже)
- `JWT_SECRET` (секретный ключ для JWT)

**Опциональные:**
- `TELEGRAM_PUBLISH_GROUP_ID` (ID группы для публикации)
- `NODE_ENV=production`

---

## Пошаговая инструкция

### Шаг 1: Подготовка пароля админа

Сгенерируйте хеш пароля:
```bash
npm run dev
# В консоли Node.js:
const bcrypt = require('bcryptjs');
bcrypt.hashSync('ваш_пароль', 10)
```

Или используйте скрипт (если есть).

### Шаг 2: Создание проекта в Vercel

1. Откройте [Vercel Dashboard](https://vercel.com/dashboard)
2. Нажмите **Add New** → **Project**
3. Выберите репозиторий `yummspb13/chatbot_tg`
4. Нажмите **Import**

### Шаг 3: Настройки проекта

- **Framework Preset:** Next.js (автоматически)
- **Root Directory:** `.` (корень)
- **Build Command:** `npm run build` (по умолчанию)
- **Output Directory:** `.next` (по умолчанию)

### Шаг 4: Environment Variables

В разделе **Environment Variables** добавьте все переменные из списка выше.

**Важно:** 
- Выберите все окружения: Production, Preview, Development
- Для `NEXT_PUBLIC_*` переменных это обязательно

### Шаг 5: Деплой

Нажмите **Deploy** и дождитесь завершения (обычно 2-3 минуты).

---

## После деплоя

1. Откройте ваш проект на Vercel (URL будет типа `your-project.vercel.app`)
2. Проверьте админ-панель: `https://your-project.vercel.app/admin`
3. Войдите с логином и паролем
4. Перейдите в `/admin/qr-auth` для QR-логина воркера

---

## Проверка

После деплоя проверьте:
- ✅ Админ-панель открывается
- ✅ Логин работает
- ✅ QR-код генерируется
- ✅ Воркер доступен: https://chatbot-tg.onrender.com/health

