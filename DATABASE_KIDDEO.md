# Использование БД Kiddeo

## Можно ли использовать одну БД?

✅ **Да, можно**, но нужно проверить конфликты таблиц.

---

## Проверка конфликтов

Наши таблицы:
- `City`
- `Channel`
- `BotSettings`
- `DraftEvent`
- `LearningDecision`
- `AdminUser`

**Важно:** Если в БД Kiddeo уже есть таблицы с такими же именами, будет конфликт!

---

## Варианты решения

### Вариант 1: Отдельная схема (PostgreSQL) ✅ Рекомендуется

Используйте отдельную схему в той же БД:

```sql
-- Создайте схему для бота
CREATE SCHEMA IF NOT EXISTS afisha_bot;

-- Используйте схему при создании таблиц
SET search_path TO afisha_bot, public;

-- Затем выполните init-postgres.sql
```

Обновите `DATABASE_URL`:
```
DATABASE_URL="postgresql://user:pass@host:5432/kiddeo?schema=afisha_bot&sslmode=require"
```

**Преимущества:**
- ✅ Изоляция таблиц
- ✅ Нет конфликтов имен
- ✅ Легко удалить все таблицы бота (DROP SCHEMA)
- ✅ Одна БД, проще управлять

### Вариант 2: Префикс таблиц

Переименуйте таблицы с префиксом:

```sql
-- Вместо City
CREATE TABLE "AfishaBot_City" (...);

-- Вместо Channel
CREATE TABLE "AfishaBot_Channel" (...);
```

**Недостатки:**
- ❌ Нужно обновить Prisma schema
- ❌ Больше работы

### Вариант 3: Отдельная БД

Создайте отдельную БД для бота.

**Преимущества:**
- ✅ Полная изоляция
- ✅ Нет риска конфликтов

**Недостатки:**
- ❌ Две БД для управления
- ❌ Дополнительные расходы (если платно)

---

## Рекомендация

**Используйте Вариант 1 (отдельная схема)** - это самый чистый способ.

---

## Как проверить существующие таблицы

```sql
-- В PostgreSQL
SELECT table_name 
FROM information_schema.tables 
WHERE table_schema = 'public';
```

Если там есть `City`, `Channel` и т.д. - используйте схему `afisha_bot`.

---

## Обновление Prisma для схемы

Если используете схему, обновите `prisma/schema.prisma`:

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
  schemas  = ["afisha_bot"]
}

// Затем в каждом model добавьте:
model City {
  // ...
  @@schema("afisha_bot")
}
```

Или используйте `search_path` в `DATABASE_URL` (проще).

---

## Итог

✅ **Можно использовать БД Kiddeo**, но лучше через отдельную схему `afisha_bot` для изоляции.

