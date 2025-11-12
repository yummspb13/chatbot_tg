# Механизм пробуждения Worker

## Проблема

Worker на Render.com может "уснуть" (idle timeout) после периода бездействия. Когда Worker спит, он не может получать новые сообщения из Telegram каналов.

## Решение

Добавлен автоматический механизм пробуждения Worker:

1. **Endpoint для пробуждения**: `POST /runner/wake`
   - Проверяет статус Worker
   - Если Worker не работает или мониторинг не активен, перезапускает его
   - Возвращает статус пробуждения

2. **Автоматическое пробуждение при получении сообщений**:
   - Когда Vercel получает сообщение из канала (через webhook)
   - Автоматически проверяет статус Worker
   - Если Worker не работает, пробуждает его

3. **Утилита для пробуждения**: `lib/worker/wake-worker.ts`
   - Проверяет статус Worker через `/runner/status`
   - Пробуждает Worker через `/runner/wake` если нужно

## Как это работает

### Сценарий 1: Worker уснул, пришло новое сообщение

1. Telegram отправляет сообщение в канал
2. Worker не получает его (уснул)
3. **НО**: Если сообщение приходит напрямую в Vercel (через другой механизм), Vercel автоматически пробуждает Worker

### Сценарий 2: Worker работает, но мониторинг не активен

1. Vercel получает сообщение из канала
2. Проверяет статус Worker
3. Если мониторинг не активен, пробуждает Worker
4. Worker перезапускает мониторинг и начинает обрабатывать сообщения

## Настройка

### Переменные окружения

В Vercel нужно установить:
- `NEXT_PUBLIC_WORKER_URL` или `WORKER_URL` - URL Worker (например, `https://chatbot-tg.onrender.com`)

### Проверка работы

1. Проверьте статус Worker:
   ```bash
   curl https://chatbot-tg.onrender.com/runner/status
   ```

2. Пробудите Worker вручную:
   ```bash
   curl -X POST https://chatbot-tg.onrender.com/runner/wake
   ```

3. Отправьте сообщение в канал и проверьте логи:
   - В Vercel логах должно появиться: `[wakeWorker] Проверяю статус Worker...`
   - Если Worker был спящим: `[wakeWorker] ✅ Worker был пробужден`

## Дополнительные решения

### Вариант 1: Периодический health check (рекомендуется)

Настройте внешний cron сервис (например, cron-job.org) для периодических запросов к Worker:

- **URL**: `https://chatbot-tg.onrender.com/health`
- **Частота**: каждые 5-10 минут
- Это предотвратит idle timeout на Render.com

### Вариант 2: Render.com платный план

На платном плане Render.com Worker не засыпает автоматически.

### Вариант 3: Использовать другой сервис

- Railway.app - не имеет idle timeout на free плане
- Fly.io - не имеет idle timeout
- DigitalOcean App Platform - имеет более длительный idle timeout

## Логи

При пробуждении Worker в логах будет видно:

```
[wakeWorker] Проверяю статус Worker: https://chatbot-tg.onrender.com
[wakeWorker] ⚠️ Worker не работает или мониторинг не активен, пробуждаю...
[wakeWorker] Отправляю запрос на пробуждение: https://chatbot-tg.onrender.com/runner/wake
[wakeWorker] ✅ Worker был пробужден
```

Или если Worker уже работает:

```
[wakeWorker] Проверяю статус Worker: https://chatbot-tg.onrender.com
[wakeWorker] ✅ Worker уже работает
```

