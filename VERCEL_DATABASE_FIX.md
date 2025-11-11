# Исправление ошибки Prisma на Vercel

## ❌ Ошибка:
```
PrismaClientInitializationError: Invalid `prisma.botSettings.findFirst()` invocation: 
error: Error validating datasource `db`: the URL must start with the protocol `file:`.
```

## 🔍 Причина:
Vercel все еще использует старую версию кода или неправильный `DATABASE_URL`.

## ✅ Решение:

### 1. Проверьте DATABASE_URL в Vercel

Зайдите в настройки проекта Vercel:
- Settings → Environment Variables
- Найдите `DATABASE_URL`
- **Должно быть:**
  ```
  postgresql://user:password@host:5432/database?sslmode=require
  ```
- **НЕ должно быть:**
  ```
  file:./dev.db
  ```

### 2. Пересоберите проект

После изменения `DATABASE_URL`:
1. Перейдите в Deployments
2. Нажмите "Redeploy" на последнем деплое
3. Или дождитесь автоматического деплоя после коммита

### 3. Проверьте schema.prisma

Убедитесь, что в `prisma/schema.prisma`:
```prisma
datasource db {
  provider = "postgresql"  // ✅ Должно быть postgresql
  url      = env("DATABASE_URL")
}
```

### 4. Проверьте логи

После деплоя отправьте `/start` боту и проверьте логи Vercel:
- Должны быть логи: `📥 WEBHOOK RECEIVED: message`
- НЕ должно быть ошибок Prisma

## 🔧 Если все еще не работает:

1. **Очистите кеш Vercel:**
   - Settings → General → Clear Build Cache
   - Redeploy

2. **Проверьте формат DATABASE_URL:**
   ```bash
   # Правильный формат для PostgreSQL:
   postgresql://user:password@host:5432/database?sslmode=require
   
   # Или с schema:
   postgresql://user:password@host:5432/database?schema=afisha_bot&sslmode=require
   ```

3. **Проверьте доступ к БД:**
   - Убедитесь, что БД доступна из интернета
   - Проверьте firewall настройки
   - Проверьте SSL режим

