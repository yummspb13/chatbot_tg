# Исправление ошибки AUTH_KEY_DUPLICATED

## Проблема

Ошибка `406: AUTH_KEY_DUPLICATED` означает, что `TELEGRAM_SESSION_STRING` используется одновременно в нескольких местах.

Telegram не позволяет использовать одну и ту же сессию одновременно в разных местах.

## Причины

1. **Локальный Worker запущен одновременно с Render.com**
   - У вас запущен Worker локально (`npm run worker:dev` или `npm run worker:start`)
   - И одновременно Worker запущен на Render.com

2. **Несколько инстансов Worker на Render.com**
   - Создано несколько сервисов с одним и тем же `TELEGRAM_SESSION_STRING`

3. **Старая сессия используется в другом месте**
   - Сессия была создана для другого проекта/сервиса

## Решение

### Вариант 1: Остановить локальный Worker (если запущен)

```bash
# Найдите процесс Worker
ps aux | grep "worker"

# Остановите его (Ctrl+C или kill)
```

### Вариант 2: Создать новую сессию для Render.com

1. **Удалите старую сессию из Render.com**
   - Откройте Render.com Dashboard
   - Environment Variables
   - Удалите `TELEGRAM_SESSION_STRING` (или оставьте пустым)

2. **Создайте новую сессию через QR-код**
   - Откройте админ-панель: `https://chatbot-tg.vercel.app/admin/qr-auth`
   - Или используйте Worker API: `POST https://chatbot-tg.onrender.com/auth/qr/start`
   - Отсканируйте QR-код
   - Получите новый `TELEGRAM_SESSION_STRING`

3. **Добавьте новую сессию в Render.com**
   - Environment Variables → `TELEGRAM_SESSION_STRING`
   - Вставьте новый `TELEGRAM_SESSION_STRING`
   - Сохраните и перезапустите сервис

### Вариант 3: Использовать разные сессии для разных окружений

Если вам нужно запускать Worker и локально, и на Render.com:

1. **Локально**: используйте один `TELEGRAM_SESSION_STRING` в `.env`
2. **Render.com**: используйте другой `TELEGRAM_SESSION_STRING` в Environment Variables

**ВАЖНО**: Каждая сессия должна быть создана через отдельный QR-код!

## Проверка

После исправления проверьте логи Render.com:

```
✅ Подключаюсь к Telegram...
✅ Connection complete!
✅ Мониторинг запущен
```

Вместо:

```
❌ Ошибка запуска мониторинга: 406: AUTH_KEY_DUPLICATED
```

## Быстрая проверка

1. **Остановите локальный Worker** (если запущен):
   ```bash
   # Проверьте, запущен ли Worker локально
   lsof -i :3001
   # Или
   ps aux | grep "worker"
   ```

2. **Проверьте Render.com Dashboard**:
   - Убедитесь, что запущен только один сервис Worker
   - Проверьте, что `TELEGRAM_SESSION_STRING` установлен

3. **Перезапустите Worker на Render.com**:
   - Render.com Dashboard → Ваш сервис → Manual Deploy → Deploy latest commit

## Если проблема сохраняется

1. **Создайте полностью новую сессию**:
   - Удалите `TELEGRAM_SESSION_STRING` из Render.com
   - Создайте новую сессию через QR-код
   - Добавьте новую сессию в Render.com

2. **Проверьте, не используется ли сессия в другом проекте**:
   - Проверьте другие Render.com сервисы
   - Проверьте другие VPS/серверы
   - Проверьте локальные проекты

