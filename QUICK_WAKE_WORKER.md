# Быстрое пробуждение Worker

## Проблема: Worker уснул и не получает сообщения

Если Worker на Render.com уснул (idle timeout), он не может получить сообщения из Telegram.

## Решение 1: Пробуждение через Worker напрямую (РАБОТАЕТ СЕЙЧАС)

Пока endpoint `/api/worker/wake` не задеплоен, используйте прямой вызов Worker:

```bash
curl -X POST https://chatbot-tg.onrender.com/runner/wake
```

Или через браузер откройте:
```
https://chatbot-tg.onrender.com/runner/wake
```

## Решение 2: Пробуждение через Vercel (после деплоя)

После того как последний коммит задеплоится на Vercel, можно использовать:

```bash
curl https://chatbot-tg.vercel.app/api/worker/wake
```

Или через браузер:
```
https://chatbot-tg.vercel.app/api/worker/wake
```

## Решение 3: Настройка автоматического пробуждения (РЕКОМЕНДУЕТСЯ)

Настройте cron для автоматического пробуждения каждые 5 минут:

1. Зарегистрируйтесь на [cron-job.org](https://cron-job.org) (бесплатно)
2. Создайте новую задачу:
   - **URL**: `https://chatbot-tg.onrender.com/runner/wake` (прямой вызов Worker)
   - **Метод**: POST
   - **Частота**: каждые 5-10 минут
   - **Описание**: "Пробуждение Worker каждые 5 минут"

3. **Альтернатива** (после деплоя Vercel):
   - **URL**: `https://chatbot-tg.vercel.app/api/worker/wake`
   - **Метод**: GET или POST
   - **Частота**: каждые 5-10 минут

## Проверка статуса Worker

```bash
curl https://chatbot-tg.onrender.com/runner/status
```

Должен вернуть:
```json
{
  "isRunning": true,
  "monitoring": {
    "isMonitoring": true,
    "isConnected": true
  }
}
```

## Если endpoint `/api/worker/wake` возвращает 404

Это значит, что последний коммит еще не задеплоен на Vercel. 

**Что делать:**
1. Проверьте статус деплоя в Vercel Dashboard
2. Дождитесь завершения деплоя
3. Или используйте прямое пробуждение Worker: `https://chatbot-tg.onrender.com/runner/wake`

