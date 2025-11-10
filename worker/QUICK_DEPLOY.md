# 🚀 Быстрый деплой на Render.com

## Настройки в Render.com

### Обязательные поля:

1. **Language:** `Node`
2. **Root Directory:** `worker`
3. **Build Command:** `npm install && npm run build`
4. **Start Command:** `npm start`
5. **Instance Type:** `Starter` ($9/месяц) ⚠️ НЕ Free!

### Environment Variables:

```
TELEGRAM_API_ID=17349
TELEGRAM_API_HASH=344583e45741c457fe1862106095a5eb
TELEGRAM_SESSION_STRING= (получите после QR-логина)
```

---

## После деплоя

1. **Проверьте health check:**
   ```bash
   curl https://your-worker.onrender.com/health
   ```
   Должен вернуть: `{"status":"ok","timestamp":"..."}`

2. **Обновите .env в админ-панели (Vercel):**
   ```
   NEXT_PUBLIC_WORKER_URL=https://your-worker.onrender.com
   ```

3. **Откройте админ-панель:**
   - Перейдите в `/admin/qr-auth`
   - Отсканируйте QR-код
   - Получите `TELEGRAM_SESSION_STRING`

4. **Добавьте сессию в Render:**
   - Environment Variables → `TELEGRAM_SESSION_STRING`
   - Сохраните (сервис перезапустится автоматически)

---

## Готово! 🎉

Теперь воркер работает и готов обрабатывать сообщения из Telegram каналов.

