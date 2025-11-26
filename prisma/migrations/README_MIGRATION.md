# Инструкция по выполнению миграции

## Проблема
При выполнении миграции возникает ошибка:
```
ERROR: 42P01: relation "afisha_bot_BotSettings" does not exist
```

Это означает, что таблицы еще не созданы в БД.

## Решение

Выполните полную миграцию из файла `manual_migration.sql`:

1. **Откройте файл** `prisma/migrations/manual_migration.sql`

2. **Скопируйте весь SQL код** из файла

3. **Выполните в вашей PostgreSQL БД**:
   - Через pgAdmin
   - Через psql
   - Через любой другой SQL клиент

4. **Миграция выполнит**:
   - Создание всех базовых таблиц (если их нет)
   - Создание всех индексов
   - Создание внешних ключей
   - Добавление новых полей
   - Создание таблицы Conversation
   - Вставку начальных данных

## Проверка

После выполнения миграции проверьте:

```sql
-- Проверка таблиц
SELECT table_name 
FROM information_schema.tables 
WHERE table_schema = 'public' 
AND table_name LIKE 'afisha_bot_%'
ORDER BY table_name;

-- Проверка полей в BotSettings
SELECT column_name, data_type, is_nullable
FROM information_schema.columns 
WHERE table_name = 'afisha_bot_BotSettings'
ORDER BY ordinal_position;

-- Проверка полей в DraftEvent
SELECT column_name, data_type, is_nullable
FROM information_schema.columns 
WHERE table_name = 'afisha_bot_DraftEvent'
ORDER BY ordinal_position;

-- Проверка таблицы Conversation
SELECT column_name, data_type, is_nullable
FROM information_schema.columns 
WHERE table_name = 'afisha_bot_Conversation'
ORDER BY ordinal_position;
```

## Ожидаемый результат

Должны быть созданы следующие таблицы:
- `afisha_bot_City`
- `afisha_bot_Channel`
- `afisha_bot_BotSettings` (с полем `workerEnabled`)
- `afisha_bot_DraftEvent` (с полями `partnerLink`, `isFree`, `tickets`, `conversationId`)
- `afisha_bot_LearningDecision`
- `afisha_bot_AdminUser`
- `afisha_bot_Conversation` (новая)

