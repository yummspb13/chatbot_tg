# Настройка URL воркера

## Для локальной разработки

Добавьте в `.env` файл:

```env
NEXT_PUBLIC_WORKER_URL=https://chatbot-tg.onrender.com
```

После добавления перезапустите админ-панель:
```bash
npm run dev
```

---

## Для продакшена (Vercel)

1. Откройте [Vercel Dashboard](https://vercel.com/dashboard)
2. Выберите ваш проект
3. Settings → Environment Variables
4. Добавьте:
   - **Name:** `NEXT_PUBLIC_WORKER_URL`
   - **Value:** `https://chatbot-tg.onrender.com`
   - **Environment:** Production, Preview, Development (все)
5. Сохраните
6. Перезапустите деплой (или он перезапустится автоматически)

---

## Для другого хостинга

Добавьте переменную окружения `NEXT_PUBLIC_WORKER_URL` в настройках вашего хостинга.

---

## Проверка

После настройки откройте админ-панель:
- `/admin/qr-auth` - должна появиться страница с QR-кодом
- Если ошибка - проверьте консоль браузера (F12)

