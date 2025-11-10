# Настройка окружения для Render.com

## Важно: PostgreSQL, не SQLite!

⚠️ **Render.com использует PostgreSQL**, а не SQLite!

---

## Что нужно сделать:

### 1. Создать PostgreSQL базу данных

**Варианты:**

#### A. Neon.tech (рекомендуется, бесплатно)
1. Зарегистрируйтесь на [neon.tech](https://neon.tech)
2. Создайте новый проект
3. Скопируйте **Connection String** (DATABASE_URL)

#### B. Supabase (бесплатно)
1. Зарегистрируйтесь на [supabase.com](https://supabase.com)
2. Создайте новый проект
3. Settings → Database → Connection String

#### C. Render.com Postgres (платно, $7/месяц)
1. Render Dashboard → New → Postgres
2. Создайте базу данных
3. Скопируйте Internal Database URL

---

### 2. Выполнить SQL скрипт

После создания БД выполните SQL скрипт:

**Через SQL Editor:**
1. Откройте SQL Editor в вашей БД
2. Скопируйте содержимое `prisma/init-postgres.sql`
3. Выполните скрипт

**Или через Prisma:**
```bash
# Установите DATABASE_URL
export DATABASE_URL="postgresql://user:pass@host:5432/db?sslmode=require"

# Выполните миграцию
npx prisma db push
```

---

### 3. Добавить DATABASE_URL в Render.com

В Render.com для **админ-панели** добавьте:

```
DATABASE_URL=postgresql://user:pass@host:5432/kiddeo?sslmode=require
```

**Важно:** Используйте БД Kiddeo или создайте новую, но обязательно PostgreSQL!

---

### 4. Обновить Prisma для продакшена

Для продакшена нужно изменить `prisma/schema.prisma`:

```prisma
datasource db {
  provider = "postgresql"  // Изменить с sqlite на postgresql
  url      = env("DATABASE_URL")
}
```

Или используйте переменную окружения для переключения.

---

## Проверка

После настройки проверьте:

```bash
# Локально (если настроен DATABASE_URL)
npx prisma studio
```

Должны увидеть таблицы с префиксом `afisha_bot_`.

---

## Итог

✅ **Для Render.com нужен PostgreSQL**  
✅ **Используйте Neon/Supabase (бесплатно) или Render Postgres**  
✅ **Выполните `prisma/init-postgres.sql`**  
✅ **Добавьте DATABASE_URL в Render Environment Variables**

