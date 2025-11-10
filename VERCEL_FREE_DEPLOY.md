# Деплой админ-панели на Vercel (бесплатно)

## Преимущества Vercel

✅ **Бесплатно** для Next.js приложений  
✅ Автоматический деплой из GitHub  
✅ Быстрый и надежный  
✅ HTTPS из коробки  

---

## Пошаговая инструкция

### Шаг 1: Подключение репозитория

1. Откройте [Vercel Dashboard](https://vercel.com/dashboard)
2. Нажмите **Add New** → **Project**
3. Выберите репозиторий `yummspb13/chatbot_tg`
4. Нажмите **Import**

### Шаг 2: Настройки проекта

Vercel автоматически определит Next.js, но проверьте:

- **Framework Preset:** Next.js ✅
- **Root Directory:** `.` (корень)
- **Build Command:** `npm run build` (по умолчанию)
- **Output Directory:** `.next` (по умолчанию)

### Шаг 3: Environment Variables

В разделе **Environment Variables** добавьте:

**Обязательные:**
```
NEXT_PUBLIC_WORKER_URL=https://chatbot-tg.onrender.com
TELEGRAM_BOT_TOKEN=ваш_токен_бота
TELEGRAM_ADMIN_CHAT_ID=ваш_telegram_id
OPENAI_API_KEY=ваш_openai_ключ
DATABASE_URL=строка_подключения_к_бд
Afisha_API_URL=https://kiddeo.vercel.app
Afisha_API_KEY=ваш_ключ_афиши
```

**Для админ-панели:**
```
ADMIN_USERNAME=admin
ADMIN_PASSWORD_HASH=хеш_пароля
JWT_SECRET=случайная_строка_для_jwt
```

**Опциональные:**
```
TELEGRAM_PUBLISH_GROUP_ID=id_группы
NODE_ENV=production
```

**Важно:** Для `NEXT_PUBLIC_*` переменных выберите все окружения (Production, Preview, Development)

### Шаг 4: Генерация хеша пароля

```bash
npm run admin:password-hash "ваш_пароль"
```

Скопируйте полученный хеш в `ADMIN_PASSWORD_HASH`

### Шаг 5: Деплой

Нажмите **Deploy** и дождитесь завершения (обычно 2-3 минуты)

---

## После деплоя

1. Vercel даст URL типа: `your-project.vercel.app`
2. Откройте админ-панель: `https://your-project.vercel.app/admin`
3. Войдите с логином и паролем
4. Перейдите в `/admin/qr-auth` для QR-логина воркера

---

## Про воркер

⚠️ **Воркер нельзя на Vercel** - он требует постоянного процесса.

**Варианты:**
1. **Оставить на Render.com бесплатном** - будет засыпать, но для тестирования сойдет
2. **Fly.io бесплатный** - попробовать (есть ограничения)
3. **Локально** - запускать воркер на своем компьютере (для разработки)

Для продакшена воркер все равно нужен на платном тарифе, но для начала можно тестировать на бесплатном Render.com.

---

## Проверка

После деплоя проверьте:
- ✅ Админ-панель открывается
- ✅ Логин работает
- ✅ QR-код генерируется (если воркер не спит)
- ✅ Воркер доступен: https://chatbot-tg.onrender.com/health

---

## Важно

- Vercel бесплатный тариф отлично подходит для Next.js
- Воркер на Render.com бесплатном будет засыпать, но можно "разбудить" запросом
- Для постоянной работы воркера нужен платный тариф (но это позже)

