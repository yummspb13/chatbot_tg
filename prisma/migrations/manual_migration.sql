-- Полная миграция: создание всех таблиц и добавление новых полей
-- Дата: 2025-01-XX
-- Выполните этот скрипт полностью в вашей PostgreSQL БД

-- ============================================
-- ЧАСТЬ 1: Создание базовых таблиц (если их нет)
-- ============================================

-- Таблица городов
CREATE TABLE IF NOT EXISTS "afisha_bot_City" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "afisha_bot_City_pkey" PRIMARY KEY ("id")
);

-- Таблица каналов
CREATE TABLE IF NOT EXISTS "afisha_bot_Channel" (
    "id" SERIAL NOT NULL,
    "cityId" INTEGER NOT NULL,
    "chatId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastCheckedMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "afisha_bot_Channel_pkey" PRIMARY KEY ("id")
);

-- Таблица настроек бота
CREATE TABLE IF NOT EXISTS "afisha_bot_BotSettings" (
    "id" SERIAL NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'MANUAL',
    "confidenceThreshold" DOUBLE PRECISION NOT NULL DEFAULT 0.8,
    "isRunning" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "afisha_bot_BotSettings_pkey" PRIMARY KEY ("id")
);

-- Таблица черновиков мероприятий
CREATE TABLE IF NOT EXISTS "afisha_bot_DraftEvent" (
    "id" SERIAL NOT NULL,
    "cityId" INTEGER,
    "channelId" INTEGER,
    "telegramMessageId" TEXT NOT NULL,
    "telegramChatId" TEXT NOT NULL,
    "sourceLink" TEXT,
    "title" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "venue" TEXT,
    "description" TEXT,
    "cityName" TEXT,
    "coverImage" TEXT,
    "gallery" TEXT,
    "pendingGallery" TEXT,
    "adminNotes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "afisha_bot_DraftEvent_pkey" PRIMARY KEY ("id")
);

-- Таблица решений для обучения
CREATE TABLE IF NOT EXISTS "afisha_bot_LearningDecision" (
    "id" SERIAL NOT NULL,
    "telegramMessageId" TEXT NOT NULL,
    "telegramChatId" TEXT NOT NULL,
    "originalText" TEXT NOT NULL,
    "extractedFields" TEXT NOT NULL,
    "userDecision" TEXT NOT NULL,
    "agentPrediction" TEXT NOT NULL,
    "agentConfidence" DOUBLE PRECISION NOT NULL,
    "agentReasoning" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "afisha_bot_LearningDecision_pkey" PRIMARY KEY ("id")
);

-- Таблица админов
CREATE TABLE IF NOT EXISTS "afisha_bot_AdminUser" (
    "id" SERIAL NOT NULL,
    "username" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "afisha_bot_AdminUser_pkey" PRIMARY KEY ("id")
);

-- ============================================
-- ЧАСТЬ 2: Создание индексов для базовых таблиц
-- ============================================

-- Уникальные индексы
CREATE UNIQUE INDEX IF NOT EXISTS "afisha_bot_City_slug_key" ON "afisha_bot_City"("slug");
CREATE UNIQUE INDEX IF NOT EXISTS "afisha_bot_Channel_chatId_key" ON "afisha_bot_Channel"("chatId");
CREATE UNIQUE INDEX IF NOT EXISTS "afisha_bot_BotSettings_id_key" ON "afisha_bot_BotSettings"("id");
CREATE UNIQUE INDEX IF NOT EXISTS "afisha_bot_AdminUser_username_key" ON "afisha_bot_AdminUser"("username");

-- Обычные индексы для оптимизации
CREATE INDEX IF NOT EXISTS "afisha_bot_Channel_cityId_idx" ON "afisha_bot_Channel"("cityId");
CREATE INDEX IF NOT EXISTS "afisha_bot_Channel_isActive_idx" ON "afisha_bot_Channel"("isActive");
CREATE INDEX IF NOT EXISTS "afisha_bot_DraftEvent_telegramMessageId_telegramChatId_idx" ON "afisha_bot_DraftEvent"("telegramMessageId", "telegramChatId");
CREATE INDEX IF NOT EXISTS "afisha_bot_DraftEvent_title_startDate_idx" ON "afisha_bot_DraftEvent"("title", "startDate");
CREATE INDEX IF NOT EXISTS "afisha_bot_DraftEvent_status_idx" ON "afisha_bot_DraftEvent"("status");
CREATE INDEX IF NOT EXISTS "afisha_bot_LearningDecision_telegramMessageId_telegramChatId_idx" ON "afisha_bot_LearningDecision"("telegramMessageId", "telegramChatId");
CREATE INDEX IF NOT EXISTS "afisha_bot_LearningDecision_userDecision_idx" ON "afisha_bot_LearningDecision"("userDecision");
CREATE INDEX IF NOT EXISTS "afisha_bot_LearningDecision_createdAt_idx" ON "afisha_bot_LearningDecision"("createdAt");

-- ============================================
-- ЧАСТЬ 3: Создание внешних ключей для базовых таблиц
-- ============================================

-- Внешние ключи (с проверкой существования)
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'afisha_bot_Channel_cityId_fkey'
    ) THEN
        ALTER TABLE "afisha_bot_Channel" 
        ADD CONSTRAINT "afisha_bot_Channel_cityId_fkey" 
        FOREIGN KEY ("cityId") REFERENCES "afisha_bot_City"("id") 
        ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'afisha_bot_DraftEvent_cityId_fkey'
    ) THEN
        ALTER TABLE "afisha_bot_DraftEvent" 
        ADD CONSTRAINT "afisha_bot_DraftEvent_cityId_fkey" 
        FOREIGN KEY ("cityId") REFERENCES "afisha_bot_City"("id") 
        ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;

DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'afisha_bot_DraftEvent_channelId_fkey'
    ) THEN
        ALTER TABLE "afisha_bot_DraftEvent" 
        ADD CONSTRAINT "afisha_bot_DraftEvent_channelId_fkey" 
        FOREIGN KEY ("channelId") REFERENCES "afisha_bot_Channel"("id") 
        ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;

-- ============================================
-- ЧАСТЬ 4: Добавление новых полей в существующие таблицы
-- ============================================

-- Добавление поля workerEnabled в BotSettings
ALTER TABLE "afisha_bot_BotSettings" 
ADD COLUMN IF NOT EXISTS "workerEnabled" BOOLEAN NOT NULL DEFAULT true;

-- Добавление новых полей в DraftEvent
ALTER TABLE "afisha_bot_DraftEvent" 
ADD COLUMN IF NOT EXISTS "partnerLink" TEXT,
ADD COLUMN IF NOT EXISTS "isFree" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS "tickets" TEXT,
ADD COLUMN IF NOT EXISTS "conversationId" INTEGER;

-- ============================================
-- ЧАСТЬ 5: Создание новой таблицы Conversation
-- ============================================

CREATE TABLE IF NOT EXISTS "afisha_bot_Conversation" (
    "id" SERIAL NOT NULL,
    "draftEventId" INTEGER,
    "telegramChatId" TEXT NOT NULL,
    "telegramMessageId" TEXT NOT NULL,
    "messages" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "afisha_bot_Conversation_pkey" PRIMARY KEY ("id")
);

-- ============================================
-- ЧАСТЬ 6: Создание индексов для Conversation
-- ============================================

CREATE INDEX IF NOT EXISTS "afisha_bot_Conversation_draftEventId_idx" 
ON "afisha_bot_Conversation"("draftEventId");

CREATE INDEX IF NOT EXISTS "afisha_bot_Conversation_telegramChatId_telegramMessageId_idx" 
ON "afisha_bot_Conversation"("telegramChatId", "telegramMessageId");

CREATE INDEX IF NOT EXISTS "afisha_bot_Conversation_status_idx" 
ON "afisha_bot_Conversation"("status");

-- ============================================
-- ЧАСТЬ 7: Создание индекса и внешнего ключа для conversationId
-- ============================================

-- Создание индекса для conversationId в DraftEvent
CREATE INDEX IF NOT EXISTS "afisha_bot_DraftEvent_conversationId_idx" 
ON "afisha_bot_DraftEvent"("conversationId");

-- Создание уникального индекса для conversationId (один-к-одному)
CREATE UNIQUE INDEX IF NOT EXISTS "afisha_bot_DraftEvent_conversationId_key" 
ON "afisha_bot_DraftEvent"("conversationId") 
WHERE "conversationId" IS NOT NULL;

-- Добавление внешнего ключа для conversationId
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'afisha_bot_DraftEvent_conversationId_fkey'
    ) THEN
        ALTER TABLE "afisha_bot_DraftEvent" 
        ADD CONSTRAINT "afisha_bot_DraftEvent_conversationId_fkey" 
        FOREIGN KEY ("conversationId") 
        REFERENCES "afisha_bot_Conversation"("id") 
        ON DELETE SET NULL 
        ON UPDATE CASCADE;
    END IF;
END $$;

-- ============================================
-- ЧАСТЬ 8: Вставка начальных данных (если нужно)
-- ============================================

-- Вставка начальных настроек бота (если их еще нет)
INSERT INTO "afisha_bot_BotSettings" ("id", "mode", "confidenceThreshold", "isRunning", "workerEnabled") 
VALUES (1, 'MANUAL', 0.8, false, true)
ON CONFLICT ("id") DO UPDATE SET "workerEnabled" = COALESCE("afisha_bot_BotSettings"."workerEnabled", true);

-- ============================================
-- ЧАСТЬ 9: Проверка результата
-- ============================================

-- Выводим информацию о созданных таблицах и полях
SELECT 
    table_name, 
    column_name, 
    data_type, 
    is_nullable,
    column_default
FROM information_schema.columns 
WHERE table_schema = 'public' 
AND table_name IN ('afisha_bot_BotSettings', 'afisha_bot_Conversation', 'afisha_bot_DraftEvent')
ORDER BY table_name, ordinal_position;

-- Выводим список всех таблиц afisha_bot_*
SELECT table_name 
FROM information_schema.tables 
WHERE table_schema = 'public' 
AND table_name LIKE 'afisha_bot_%'
ORDER BY table_name;
