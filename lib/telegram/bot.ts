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
    console.warn('⚠️ Все переменные окружения:', Object.keys(process.env).filter(k => k.includes('TELEGRAM') || k.includes('ADMIN')).join(', '))
    return false
  }

  // Приводим все к строкам для сравнения
  const adminChatIdStr = adminChatId.toString().trim()
  const userId = ctx.from?.id?.toString()?.trim()
  const chatId = ctx.chat?.id?.toString()?.trim()
  const callbackUserId = ctx.callbackQuery?.from?.id?.toString()?.trim()

  // Детальное логирование для диагностики
  console.log(`🔐 [isAdmin] Проверка доступа:`)
  console.log(`   User ID: "${userId}" (type: ${typeof userId})`)
  console.log(`   Chat ID: "${chatId}" (type: ${typeof chatId})`)
  console.log(`   Callback User ID: "${callbackUserId}" (type: ${typeof callbackUserId})`)
  console.log(`   Expected Admin Chat ID: "${adminChatIdStr}" (type: ${typeof adminChatIdStr})`)
  
  // Проверяем по user ID (для личных сообщений)
  // Проверяем по chat ID (для групповых чатов)
  // Проверяем callback_query user ID
  // Используем == вместо === для более гибкого сравнения (но все уже строки)
  const isAdminUser = (userId && userId === adminChatIdStr) || 
                      (chatId && chatId === adminChatIdStr) || 
                      (callbackUserId && callbackUserId === adminChatIdStr)

  console.log(`   Сравнение userId === adminChatIdStr: ${userId === adminChatIdStr}`)
  console.log(`   Сравнение chatId === adminChatIdStr: ${chatId === adminChatIdStr}`)
  console.log(`   Сравнение callbackUserId === adminChatIdStr: ${callbackUserId === adminChatIdStr}`)
  console.log(`   Результат isAdminUser: ${isAdminUser}`)

  if (!isAdminUser) {
    console.log(`❌ [isAdmin] Access denied. User ID: "${userId}", Chat ID: "${chatId}", Expected: "${adminChatIdStr}"`)
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
        workerEnabled: true, // По умолчанию Worker включен
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
  workerEnabled?: boolean
}) {
  const settings = await getBotSettings()
  return prisma.botSettings.update({
    where: { id: settings.id },
    data,
  })
}

