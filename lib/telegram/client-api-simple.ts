/**
 * Упрощенный Client API - использует стандартные credentials
 * НЕ требует создания приложения через my.telegram.org
 */

import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions'
import { Api } from 'telegram/tl'
import { prisma } from '@/lib/db/prisma'
import { getBot } from './bot'

// Стандартные API credentials (используются в официальных клиентах Telegram)
// Эти credentials можно использовать без создания приложения
const DEFAULT_API_ID = 17349  // Стандартный API ID для Desktop
const DEFAULT_API_HASH = '344583e45741c457fe1862106095a5eb'  // Стандартный API Hash для Desktop

let clientInstance: TelegramClient | null = null

/**
 * Инициализирует Client API с стандартными credentials
 */
export function getTelegramClientSimple(): TelegramClient | null {
  // Используем стандартные credentials или из env
  const apiId = process.env.TELEGRAM_API_ID ? parseInt(process.env.TELEGRAM_API_ID) : DEFAULT_API_ID
  const apiHash = process.env.TELEGRAM_API_HASH || DEFAULT_API_HASH
  const sessionString = process.env.TELEGRAM_SESSION_STRING

  if (!sessionString) {
    console.warn('⚠️ TELEGRAM_SESSION_STRING не установлен')
    console.warn('   Нужно получить сессию через экспорт из Telegram Desktop или другого клиента')
    return null
  }

  if (clientInstance) {
    return clientInstance
  }

  const session = new StringSession(sessionString)
  
  clientInstance = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 5,
  })

  return clientInstance
}

/**
 * Подключается к Telegram
 */
export async function connectClientAPISimple(): Promise<boolean> {
  const client = getTelegramClientSimple()
  if (!client) {
    return false
  }

  try {
    if (!client.connected) {
      await client.connect()
      console.log('✅ Подключен к Telegram через Client API (стандартные credentials)')
    }
    return true
  } catch (error) {
    console.error('❌ Ошибка подключения к Telegram Client API:', error)
    return false
  }
}

/**
 * Начинает мониторинг и автоматическую пересылку
 */
export async function startChannelMonitoringSimple() {
  const client = getTelegramClientSimple()
  if (!client) {
    console.log('⚠️ Client API не настроен (нет TELEGRAM_SESSION_STRING)')
    console.log('   💡 Получите сессию через экспорт из Telegram Desktop')
    return
  }

  await connectClientAPISimple()

  const botToken = process.env.TELEGRAM_BOT_TOKEN
  const botUsername = process.env.TELEGRAM_BOT_USERNAME || 'kiddeo_afisha_bot'
  
  if (!botToken) {
    console.error('❌ TELEGRAM_BOT_TOKEN не установлен')
    return
  }

  // Получаем все активные каналы
  const channels = await prisma.channel.findMany({
    where: { isActive: true },
    include: { city: true },
  })

  console.log(`📡 Начинаю мониторинг ${channels.length} каналов через Client API...`)
  console.log(`   🔄 Автоматическая пересылка в бота @${botUsername}`)

  // Подписываемся на обновления
  client.addEventHandler(async (event: any) => {
    try {
      if (event.message && event.message.peerId) {
        const peerId = event.message.peerId
        let chatId: string | null = null
        
        if (peerId instanceof Api.PeerChannel) {
          chatId = `-100${peerId.channelId.toString()}`
        }

        if (chatId) {
          // Проверяем, что это канал из нашей базы
          const channel = await prisma.channel.findFirst({
            where: { chatId, isActive: true },
          })

          if (channel) {
            console.log(`📨 Получено сообщение из канала ${channel.title}`)
            
            // Пересылаем боту
            try {
              const botEntity = await client.getEntity(`@${botUsername}`)
              
              await client.forwardMessages(botEntity, {
                messages: [event.message.id],
                fromPeer: event.message.peerId,
              })
              
              console.log(`   ✅ Переслано боту @${botUsername}`)
            } catch (error: any) {
              console.error(`   ⚠️ Ошибка пересылки: ${error.message}`)
              console.error(`   💡 Убедитесь, что бот @${botUsername} в контактах`)
            }
          }
        }
      }
    } catch (error) {
      console.error('Ошибка обработки:', error)
    }
  })

  console.log('✅ Мониторинг запущен!')
  console.log('   💡 Аккаунт будет автоматически пересылать сообщения из каналов боту')
}

/**
 * Останавливает мониторинг
 */
export async function stopChannelMonitoringSimple() {
  const client = getTelegramClientSimple()
  if (client && client.connected) {
    await client.disconnect()
    console.log('⏹ Остановлен мониторинг')
  }
}

