# Деплой админ-панели на Render.com

## Преимущества

✅ Все в одном месте (воркер + админ-панель)  
✅ Проще управлять  
✅ Один аккаунт  

---

## Пошаговая инструкция

### Шаг 1: Создание нового Web Service

1. Откройте [Render Dashboard](https://dashboard.render.com)
2. Нажмите **New +** → **Web Service**
3. Подключите тот же репозиторий: `yummspb13/chatbot_tg`

### Шаг 2: Настройки проекта

- **Name:** `afisha-bot-admin` (или другое имя)
- **Root Directory:** `.` (корень проекта, НЕ `worker`)
- **Environment:** `Node`
- **Build Command:** `npm install && npm run build`
- **Start Command:** `npm start`
- **Plan:** `Starter` ($9/месяц) или `Free` (для тестирования)

### Шаг 3: Environment Variables

Добавьте все необходимые переменные:

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

### Шаг 4: Деплой

Нажмите **Create Web Service** и дождитесь деплоя (3-5 минут).

---

## Генерация хеша пароля

Для `ADMIN_PASSWORD_HASH` нужно сгенерировать хеш пароля:

```bash
# Локально
node -e "const bcrypt = require('bcryptjs'); console.log(bcrypt.hashSync('ваш_пароль', 10))"
```

Или создайте временный скрипт:
```bash
npm install bcryptjs
node -e "const bcrypt = require('bcryptjs'); console.log(bcrypt.hashSync(process.argv[1], 10))" "ваш_пароль"
```

---

## После деплоя

1. Render даст URL типа: `https://afisha-bot-admin.onrender.com`
2. Откройте админ-панель: `https://afisha-bot-admin.onrender.com/admin`
3. Войдите с логином и паролем
4. Перейдите в `/admin/qr-auth` для QR-логина воркера

---

## Проверка

После деплоя проверьте:
- ✅ Админ-панель открывается
- ✅ Логин работает
- ✅ QR-код генерируется
- ✅ Воркер доступен: https://chatbot-tg.onrender.com/health

---

## Важно

- На бесплатном тарифе сервис засыпает после 15 минут бездействия
- Для продакшена нужен платный тариф **Starter** ($9/месяц)
- Next.js на Render.com работает отлично, но первый запрос может быть медленным (cold start)

---

## Структура на Render.com

После деплоя у вас будет:
- **chatbot-tg** (воркер) - https://chatbot-tg.onrender.com
- **afisha-bot-admin** (админ-панель) - https://afisha-bot-admin.onrender.com

Оба сервиса в одном аккаунте, легко управлять!

