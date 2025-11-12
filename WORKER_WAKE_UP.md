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

**Проблема**: Если Worker уснул, он не может получить сообщение из Telegram, поэтому механизм автоматического пробуждения не сработает.

**Решение**: Используйте периодический cron (см. Вариант 1 ниже) для постоянного пробуждения Worker.

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

### Вариант 1: Периодический пробуждение через Worker напрямую (РЕКОМЕНДУЕТСЯ)

⚠️ **ВАЖНО:** Endpoint `/api/worker/wake` на Vercel может быть еще не задеплоен или возвращать ошибки.

**Используйте прямой вызов Worker:**

1. **Зарегистрируйтесь на [cron-job.org](https://cron-job.org)** (бесплатно)
2. **Создайте новую задачу:**
   - **URL**: `https://chatbot-tg.onrender.com/runner/wake`
   - **Метод**: ⚠️ **POST** (обязательно, не GET!)
   - **Частота**: каждые 5-10 минут
   - **Описание**: "Пробуждение Worker каждые 5 минут"

3. **Как это работает:**
   - Cron сервис вызывает Worker endpoint напрямую каждые 5 минут
   - Worker проверяет свой статус
   - Если Worker уснул, пробуждается автоматически
   - Это предотвращает idle timeout на Render.com

### Вариант 1А: Периодический пробуждение через Vercel (после деплоя)

После того как endpoint `/api/worker/wake` задеплоится на Vercel:

1. **Зарегистрируйтесь на [cron-job.org](https://cron-job.org)** (бесплатно)
2. **Создайте новую задачу:**
   - **URL**: `https://chatbot-tg.vercel.app/api/worker/wake`
   - **Метод**: GET или POST (оба работают)
   - **Частота**: каждые 5-10 минут
   - **Описание**: "Пробуждение Worker каждые 5 минут"

3. **Как это работает:**
   - Cron сервис вызывает Vercel endpoint каждые 5 минут
   - Vercel проверяет статус Worker
   - Если Worker уснул, пробуждает его
   - Это предотвращает idle timeout на Render.com

### Вариант 2: Периодический health check Worker напрямую

Настройте внешний cron сервис для периодических запросов к Worker:

- **URL**: `https://chatbot-tg.onrender.com/health`
- **Частота**: каждые 5-10 минут
- Это предотвратит idle timeout на Render.com

### Вариант 3: Render.com платный план

На платном плане Render.com Worker не засыпает автоматически.

### Вариант 4: Использовать другой сервис

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

