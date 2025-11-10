-- SQL скрипт для создания таблиц базы данных (SQLite)
-- Все таблицы с префиксом afisha_bot_ для изоляции

-- Таблица городов
CREATE TABLE IF NOT EXISTS "afisha_bot_City" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL UNIQUE,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Таблица каналов
CREATE TABLE IF NOT EXISTS "afisha_bot_Channel" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "cityId" INTEGER NOT NULL,
    "chatId" TEXT NOT NULL UNIQUE,
    "title" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastCheckedMessageId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY ("cityId") REFERENCES "afisha_bot_City"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Таблица настроек бота
CREATE TABLE IF NOT EXISTS "afisha_bot_BotSettings" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "mode" TEXT NOT NULL DEFAULT 'MANUAL',
    "confidenceThreshold" REAL NOT NULL DEFAULT 0.8,
    "isRunning" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE("id")
);

-- Таблица черновиков мероприятий
CREATE TABLE IF NOT EXISTS "afisha_bot_DraftEvent" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "cityId" INTEGER,
    "channelId" INTEGER,
    "telegramMessageId" TEXT NOT NULL,
    "telegramChatId" TEXT NOT NULL,
    "sourceLink" TEXT,
    "title" TEXT NOT NULL,
    "startDate" DATETIME NOT NULL,
    "endDate" DATETIME,
    "venue" TEXT,
    "description" TEXT,
    "cityName" TEXT,
    "coverImage" TEXT,
    "gallery" TEXT,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY ("cityId") REFERENCES "afisha_bot_City"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    FOREIGN KEY ("channelId") REFERENCES "afisha_bot_Channel"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- Таблица решений для обучения
CREATE TABLE IF NOT EXISTS "afisha_bot_LearningDecision" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "telegramMessageId" TEXT NOT NULL,
    "telegramChatId" TEXT NOT NULL,
    "originalText" TEXT NOT NULL,
    "extractedFields" TEXT NOT NULL,
    "userDecision" TEXT NOT NULL,
    "agentPrediction" TEXT NOT NULL,
    "agentConfidence" REAL NOT NULL,
    "agentReasoning" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Таблица админов
CREATE TABLE IF NOT EXISTS "afisha_bot_AdminUser" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "username" TEXT NOT NULL UNIQUE,
    "password" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Индексы для оптимизации
CREATE INDEX IF NOT EXISTS "afisha_bot_City_slug_key" ON "afisha_bot_City"("slug");
CREATE INDEX IF NOT EXISTS "afisha_bot_Channel_cityId_idx" ON "afisha_bot_Channel"("cityId");
CREATE INDEX IF NOT EXISTS "afisha_bot_Channel_isActive_idx" ON "afisha_bot_Channel"("isActive");
CREATE INDEX IF NOT EXISTS "afisha_bot_Channel_chatId_key" ON "afisha_bot_Channel"("chatId");
CREATE INDEX IF NOT EXISTS "afisha_bot_DraftEvent_telegramMessageId_telegramChatId_idx" ON "afisha_bot_DraftEvent"("telegramMessageId", "telegramChatId");
CREATE INDEX IF NOT EXISTS "afisha_bot_DraftEvent_title_startDate_idx" ON "afisha_bot_DraftEvent"("title", "startDate");
CREATE INDEX IF NOT EXISTS "afisha_bot_DraftEvent_status_idx" ON "afisha_bot_DraftEvent"("status");
CREATE INDEX IF NOT EXISTS "afisha_bot_LearningDecision_telegramMessageId_telegramChatId_idx" ON "afisha_bot_LearningDecision"("telegramMessageId", "telegramChatId");
CREATE INDEX IF NOT EXISTS "afisha_bot_LearningDecision_userDecision_idx" ON "afisha_bot_LearningDecision"("userDecision");
CREATE INDEX IF NOT EXISTS "afisha_bot_LearningDecision_createdAt_idx" ON "afisha_bot_LearningDecision"("createdAt");

-- Вставка начальных данных
INSERT OR IGNORE INTO "afisha_bot_BotSettings" ("id", "mode", "confidenceThreshold", "isRunning") 
VALUES (1, 'MANUAL', 0.8, false);
