import { Telegraf, Context } from 'telegraf'
import { prisma } from '@/lib/db/prisma'

// BotMode: "MANUAL" | "AUTO"
type BotMode = 'MANUAL' | 'AUTO'

let botInstance: Telegraf | null = null

/**
 * Инициализирует и возвращает экземпляр бота
 */
export function getBot(): Telegraf {
  if (botInstance) {
    return botInstance
  }

  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN is not set')
  }

  botInstance = new Telegraf(token, {
    // Включаем получение обновлений из каналов
    telegram: {
      // Получаем все типы обновлений, включая channel_post
    }
  })
  return botInstance
}

/**
 * Проверяет, является ли пользователь админом
 */
export function isAdmin(ctx: Context): boolean {
  const adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID
  if (!adminChatId) {
    console.warn('⚠️ TELEGRAM_ADMIN_CHAT_ID не настроен')
    return false
  }

  const userId = ctx.from?.id?.toString()
  const chatId = ctx.chat?.id?.toString()
  const callbackUserId = ctx.callbackQuery?.from?.id?.toString()

  // Детальное логирование для диагностики
  console.log(`🔐 [isAdmin] Проверка доступа:`)
  console.log(`   User ID: ${userId}`)
  console.log(`   Chat ID: ${chatId}`)
  console.log(`   Callback User ID: ${callbackUserId}`)
  console.log(`   Expected Admin Chat ID: ${adminChatId}`)

  // Проверяем по user ID (для личных сообщений)
  // Проверяем по chat ID (для групповых чатов)
  // Проверяем callback_query user ID
  const isAdminUser = userId === adminChatId || 
                      chatId === adminChatId || 
                      callbackUserId === adminChatId

  if (!isAdminUser) {
    console.log(`❌ [isAdmin] Access denied. User ID: ${userId}, Chat ID: ${chatId}, Expected: ${adminChatId}`)
  } else {
    console.log(`✅ [isAdmin] Access granted`)
  }

  return isAdminUser
}

/**
 * Получает или создает настройки бота
 */
export async function getBotSettings() {
  let settings = await prisma.botSettings.findFirst()

  if (!settings) {
    settings = await prisma.botSettings.create({
      data: {
        mode: 'MANUAL',
        confidenceThreshold: 0.8,
        isRunning: false,
      },
    })
  }

  return settings
}

/**
 * Обновляет настройки бота
 */
export async function updateBotSettings(data: {
  mode?: 'MANUAL' | 'AUTO'
  confidenceThreshold?: number
  isRunning?: boolean
}) {
  const settings = await getBotSettings()
  return prisma.botSettings.update({
    where: { id: settings.id },
    data,
  })
}

