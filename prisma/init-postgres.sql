-- SQL скрипт для создания таблиц базы данных (PostgreSQL)
-- Все таблицы с префиксом afisha_bot_ для изоляции от таблиц Kiddeo
-- Используйте этот скрипт для создания таблиц в БД Kiddeo

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

-- Внешние ключи
ALTER TABLE "afisha_bot_Channel" ADD CONSTRAINT "afisha_bot_Channel_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "afisha_bot_City"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "afisha_bot_DraftEvent" ADD CONSTRAINT "afisha_bot_DraftEvent_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "afisha_bot_City"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "afisha_bot_DraftEvent" ADD CONSTRAINT "afisha_bot_DraftEvent_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "afisha_bot_Channel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Вставка начальных данных
INSERT INTO "afisha_bot_BotSettings" ("id", "mode", "confidenceThreshold", "isRunning") 
VALUES (1, 'MANUAL', 0.8, false)
ON CONFLICT ("id") DO NOTHING;
