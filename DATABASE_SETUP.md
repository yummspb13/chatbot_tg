# Настройка базы данных

## Варианты для продакшена

### 1. Neon.tech (рекомендуется)

**Бесплатный тариф:** 0.5 GB, отлично для начала

**Шаги:**
1. Зарегистрируйтесь на [neon.tech](https://neon.tech)
2. Создайте новый проект
3. Скопируйте `Connection String` (DATABASE_URL)
4. Выполните SQL скрипт: `prisma/init-postgres.sql`

### 2. Supabase

**Бесплатный тариф:** 500 MB, хорошая альтернатива

**Шаги:**
1. Зарегистрируйтесь на [supabase.com](https://supabase.com)
2. Создайте новый проект
3. Перейдите в SQL Editor
4. Выполните скрипт: `prisma/init-postgres.sql`
5. Скопируйте Connection String

### 3. Render.com Postgres

**Платный тариф:** от $7/месяц

**Шаги:**
1. Render Dashboard → New → Postgres
2. Создайте базу данных
3. Скопируйте Internal Database URL
4. Выполните SQL скрипт

---

## Выполнение SQL скрипта

### Через Prisma (рекомендуется)

```bash
# Установите DATABASE_URL в .env
DATABASE_URL="postgresql://user:pass@host:5432/db?sslmode=require"

# Выполните миграцию
npx prisma db push
```

Или:

```bash
npx prisma migrate dev --name init
```

### Вручную через SQL Editor

1. Откройте SQL Editor в вашей БД (Neon/Supabase)
2. Скопируйте содержимое `prisma/init-postgres.sql`
3. Вставьте и выполните

---

## Для Vercel

1. Создайте БД на Neon или Supabase
2. Скопируйте `DATABASE_URL`
3. Добавьте в Vercel Environment Variables:
   ```
   DATABASE_URL=postgresql://user:pass@host:5432/db?sslmode=require
   ```
4. Выполните SQL скрипт через Prisma или вручную

---

## Проверка

После создания таблиц проверьте:

```bash
npx prisma studio
```

Или через SQL:
```sql
SELECT * FROM "City";
SELECT * FROM "Channel";
SELECT * FROM "BotSettings";
```

---

## Важно

- Для продакшена используйте PostgreSQL (не SQLite)
- SQLite только для локальной разработки
- Не коммитьте `DATABASE_URL` в Git
- Используйте переменные окружения

