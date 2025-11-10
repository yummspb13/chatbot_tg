# Запуск админ-панели

## Вариант 1: Локально (для тестирования)

### 1. Добавьте переменную окружения

Откройте `.env` файл и добавьте:
```env
NEXT_PUBLIC_WORKER_URL=https://chatbot-tg.onrender.com
```

### 2. Установите зависимости (если еще не установлены)

```bash
npm install
```

### 3. Запустите админ-панель

```bash
npm run dev
```

### 4. Откройте в браузере

- Админ-панель: http://localhost:3000/admin
- QR-авторизация: http://localhost:3000/admin/qr-auth

---

## Вариант 2: На Vercel (для продакшена)

### 1. Подключите GitHub репозиторий

1. Откройте [Vercel Dashboard](https://vercel.com/dashboard)
2. Нажмите **Add New** → **Project**
3. Выберите репозиторий `yummspb13/chatbot_tg`
4. Нажмите **Import**

### 2. Настройки проекта

- **Framework Preset:** Next.js (автоматически определится)
- **Root Directory:** `.` (корень проекта)
- **Build Command:** `npm run build` (по умолчанию)
- **Output Directory:** `.next` (по умолчанию)

### 3. Добавьте переменные окружения

В разделе **Environment Variables** добавьте:

```
NEXT_PUBLIC_WORKER_URL=https://chatbot-tg.onrender.com
```

И другие необходимые переменные (см. `.env.example` или `ENV_SETUP.md`)

### 4. Деплой

Нажмите **Deploy** - Vercel автоматически задеплоит проект.

---

## После запуска

1. Откройте админ-панель
2. Перейдите в `/admin/qr-auth`
3. Отсканируйте QR-код для авторизации Telegram
4. Получите `TELEGRAM_SESSION_STRING`
5. Добавьте его в Render.com Environment Variables

---

## Проверка

После запуска проверьте:
- Админ-панель открывается
- QR-код генерируется (страница `/admin/qr-auth`)
- Воркер доступен: https://chatbot-tg.onrender.com/health

