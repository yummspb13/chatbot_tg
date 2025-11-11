-- SQL скрипт для создания админа в базе данных
-- Используйте этот скрипт после создания таблиц (prisma/init-postgres.sql)

-- Создание админа
-- Логин: admin
-- Пароль: admin123
-- Хеш: $2b$10$OdZ25tBUlRZKSphNRrMl5uOhYqfhqLFrxXDdB9cU.XmM.yBYtxhl.

INSERT INTO "afisha_bot_AdminUser" ("username", "password", "createdAt", "updatedAt")
VALUES (
  'admin',
  '$2b$10$OdZ25tBUlRZKSphNRrMl5uOhYqfhqLFrxXDdB9cU.XmM.yBYtxhl.',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("username") DO UPDATE
SET 
  "password" = EXCLUDED."password",
  "updatedAt" = CURRENT_TIMESTAMP;

-- Проверка создания
SELECT 
  id,
  username,
  "createdAt"
FROM "afisha_bot_AdminUser"
WHERE username = 'admin';

