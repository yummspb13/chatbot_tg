-- SQL скрипт для добавления начальных данных
-- Выполните этот скрипт в Supabase SQL Editor

-- Добавляем города (если их еще нет)
INSERT INTO "afisha_bot_City" ("name", "slug", "createdAt", "updatedAt")
VALUES 
  ('Москва', 'moskva', NOW(), NOW()),
  ('Санкт-Петербург', 'sankt-peterburg', NOW(), NOW())
ON CONFLICT ("slug") DO NOTHING;

-- Добавляем настройки бота (если их еще нет)
INSERT INTO "afisha_bot_BotSettings" ("id", "mode", "confidenceThreshold", "isRunning", "updatedAt")
VALUES (1, 'MANUAL', 0.8, false, NOW())
ON CONFLICT ("id") DO NOTHING;

-- Добавляем канал "Тест Кидд" (замените chatId на реальный, если нужно)
-- Сначала нужно получить ID города Москвы
INSERT INTO "afisha_bot_Channel" ("cityId", "chatId", "title", "isActive", "createdAt", "updatedAt")
SELECT 
  (SELECT id FROM "afisha_bot_City" WHERE slug = 'moskva' LIMIT 1),
  '-1003442736774',
  'Тест Кидд',
  true,
  NOW(),
  NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM "afisha_bot_Channel" WHERE "chatId" = '-1003442736774'
);

-- Проверка: выведите добавленные данные
SELECT 'Города:' as info;
SELECT id, name, slug FROM "afisha_bot_City";

SELECT 'Каналы:' as info;
SELECT c.id, c.title, c."chatId", c."isActive", city.name as city_name
FROM "afisha_bot_Channel" c
JOIN "afisha_bot_City" city ON c."cityId" = city.id;

