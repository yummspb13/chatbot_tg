# Добавление столбца pendingGallery

## SQL скрипт для выполнения

Выполните следующий SQL скрипт в вашей базе данных PostgreSQL:

```sql
-- Добавляем столбец pendingGallery для временного хранения фото до группировки
-- Этот столбец используется для хранения фото из сообщений без текста,
-- которые будут добавлены в gallery когда будет создан draft с текстом

ALTER TABLE public."afisha_bot_DraftEvent"
ADD COLUMN IF NOT EXISTS "pendingGallery" TEXT;

-- Комментарий к столбцу
COMMENT ON COLUMN public."afisha_bot_DraftEvent"."pendingGallery" IS 'JSON массив base64 строк для временного хранения фото из сообщений без текста. Фото будут добавлены в gallery когда будет создан draft с текстом.';
```

## Как выполнить

### Вариант 1: Через psql
```bash
psql -h <host> -U <user> -d <database> -f prisma/migrations/add_pending_gallery.sql
```

### Вариант 2: Через pgAdmin или другой GUI
1. Откройте pgAdmin или другой PostgreSQL клиент
2. Подключитесь к базе данных
3. Выполните SQL скрипт из файла `prisma/migrations/add_pending_gallery.sql`

### Вариант 3: Через Vercel Postgres (если используете)
1. Откройте Vercel Dashboard
2. Перейдите в раздел Storage → Postgres
3. Откройте SQL Editor
4. Вставьте и выполните SQL скрипт

## Что делает этот столбец

- **pendingGallery** - JSON массив base64 строк для временного хранения фото
- Когда приходит сообщение только с фото (без текста) и не находится draft для группировки, фото сохраняются в `pendingGallery`
- Когда создается draft с текстом, фото из `pendingGallery` автоматически добавляются в `gallery`
- После использования `pendingGallery` очищается

## Проверка

После выполнения скрипта проверьте, что столбец добавлен:

```sql
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'afisha_bot_DraftEvent'
  AND column_name = 'pendingGallery';
```

Должен вернуться результат с `column_name = 'pendingGallery'`.

