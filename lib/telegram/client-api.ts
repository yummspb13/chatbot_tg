/**
 * Telegram Client API (MTProto) сервис
 * Используется для мониторинга каналов конкурентов через обычный аккаунт
 */

import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions'
import { Api } from 'telegram/tl'
import { prisma } from '@/lib/db/prisma'
import { handleChannelMessage } from './messageHandler'
import { Context } from 'telegraf'

let clientInstance: TelegramClient | null = null

/**
 * Инициализирует и возвращает экземпляр Telegram Client
 */
export function getTelegramClient(): TelegramClient | null {
  const apiId = process.env.TELEGRAM_API_ID
  const apiHash = process.env.TELEGRAM_API_HASH
  const sessionString = process.env.TELEGRAM_SESSION_STRING

  if (!apiId || !apiHash) {
    console.warn('⚠️ TELEGRAM_API_ID или TELEGRAM_API_HASH не установлены')
    console.warn('   Client API не будет работать')
    return null
  }

  if (!sessionString) {
    console.warn('⚠️ TELEGRAM_SESSION_STRING не установлен')
    console.warn('   Нужно сначала авторизоваться (см. scripts/setup-client-api.ts)')
    return null
  }

  if (clientInstance) {
    return clientInstance
  }

  const session = new StringSession(sessionString)
  
  clientInstance = new TelegramClient(session, parseInt(apiId), apiHash, {
    connectionRetries: 5,
  })

  return clientInstance
}

/**
 * Подключается к Telegram через Client API
 */
export async function connectClientAPI(): Promise<boolean> {
  const client = getTelegramClient()
  if (!client) {
    return false
  }

  try {
    if (!client.connected) {
      await client.connect()
      console.log('✅ Подключен к Telegram через Client API')
    }
    return true
  } catch (error) {
    console.error('❌ Ошибка подключения к Telegram Client API:', error)
    return false
  }
}

/**
 * Получает информацию о канале через Client API
 */
export async function getChannelByUsername(username: string) {
  const client = getTelegramClient()
  if (!client || !client.connected) {
    throw new Error('Client API не подключен')
  }

  // Убираем @ если есть
  const cleanUsername = username.replace('@', '')
  
  try {
    const entity = await client.getEntity(cleanUsername)
    return entity
  } catch (error) {
    console.error(`Ошибка получения канала ${username}:`, error)
    throw error
  }
}

/**
 * Получает Chat ID канала через Client API
 */
export async function getChannelChatId(username: string): Promise<string | null> {
  try {
    const channel = await getChannelByUsername(username)
    if (channel instanceof Api.Channel || channel instanceof Api.ChannelForbidden) {
      // Для каналов ID нужно преобразовать
      const channelId = channel.id
      // Telegram использует отрицательные ID для каналов: -100 + channelId
      const chatId = `-100${channelId.toString()}`
      return chatId
    }
    return null
  } catch (error) {
    console.error(`Ошибка получения Chat ID для ${username}:`, error)
    return null
  }
}

/**
 * Начинает мониторинг каналов через Client API
 * Автоматически пересылает все сообщения из каналов в бота
 */
export async function startChannelMonitoring() {
  const client = getTelegramClient()
  if (!client) {
    console.log('⚠️ Client API не настроен, пропускаю мониторинг')
    return
  }

  await connectClientAPI()

  const botToken = process.env.TELEGRAM_BOT_TOKEN
  if (!botToken) {
    console.error('❌ TELEGRAM_BOT_TOKEN не установлен, не могу пересылать сообщения')
    return
  }

  // Получаем все активные каналы из базы
  const channels = await prisma.channel.findMany({
    where: {
      isActive: true,
    },
    include: {
      city: true,
    },
  })

  console.log(`📡 Начинаю мониторинг ${channels.length} каналов через Client API...`)
  console.log(`   🔄 Автоматическая пересылка в бота включена`)

  // Подписываемся на обновления из всех каналов
  client.addEventHandler(async (event: any) => {
    try {
      // Проверяем, что это сообщение из канала
      if (event.message && event.message.peerId) {
        const peerId = event.message.peerId
        
        // Преобразуем peerId в chatId
        let chatId: string | null = null
        
        if (peerId instanceof Api.PeerChannel) {
          chatId = `-100${peerId.channelId.toString()}`
        } else if (peerId instanceof Api.PeerChat) {
          chatId = `-${peerId.chatId.toString()}`
        }

        if (chatId) {
          // Проверяем, что это канал из нашей базы
          const channel = await prisma.channel.findFirst({
            where: {
              chatId,
              isActive: true,
            },
          })

          if (channel) {
            console.log(`📨 Получено сообщение из канала ${channel.title} через Client API`)
            
            // Автоматически пересылаем сообщение боту
            try {
              const botUsername = process.env.TELEGRAM_BOT_USERNAME || 'kiddeo_afisha_bot'
              console.log(`   🔄 Пересылаю сообщение боту @${botUsername}...`)
              
              // Получаем entity бота
              const botEntity = await client.getEntity(`@${botUsername}`)
              
              // Пересылаем сообщение боту
              await client.forwardMessages(botEntity, {
                messages: [event.message.id],
                fromPeer: event.message.peerId,
              })
              
              console.log(`   ✅ Сообщение переслано боту @${botUsername}`)
              console.log(`   💡 Бот получит пересланное сообщение и обработает его`)
            } catch (forwardError: any) {
              console.error(`   ⚠️ Ошибка пересылки боту: ${forwardError.message}`)
              console.error(`   💡 Решения:`)
              console.error(`      1. Убедитесь, что бот @${process.env.TELEGRAM_BOT_USERNAME || 'kiddeo_afisha_bot'} добавлен в контакты аккаунта @yummspb`)
              console.error(`      2. Откройте бота в Telegram и отправьте ему любое сообщение`)
              console.error(`      3. Проверьте, что TELEGRAM_BOT_USERNAME правильный`)
              
              // Если пересылка не удалась, обрабатываем напрямую (fallback)
              console.log(`   🔄 Fallback: обрабатываю сообщение напрямую...`)
              const message = convertClientMessageToBotMessage(event.message, chatId)
              const ctx = createContextFromClientMessage(message, chatId)
              await handleChannelMessage(ctx)
            }
          }
        }
      }
    } catch (error) {
      console.error('Ошибка обработки сообщения из Client API:', error)
    }
  })

  console.log('✅ Мониторинг каналов через Client API запущен')
  console.log('   💡 Аккаунт @yummspb будет автоматически пересылать сообщения боту')
}

/**
 * Преобразует сообщение из Client API в формат Bot API
 */
function convertClientMessageToBotMessage(clientMessage: any, chatId: string): any {
  return {
    message_id: clientMessage.id,
    date: clientMessage.date ? Math.floor(clientMessage.date.getTime() / 1000) : Math.floor(Date.now() / 1000),
    chat: {
      id: parseInt(chatId),
      type: 'channel',
    },
    text: clientMessage.message || '',
    caption: clientMessage.message || '',
    // Добавляем поддержку медиа
    photo: clientMessage.media instanceof Api.MessageMediaPhoto ? {
      file_id: 'client_api_photo',
      // Можно добавить больше полей при необходимости
    } : undefined,
  }
}

/**
 * Создает контекст Telegraf из сообщения Client API
 */
function createContextFromClientMessage(message: any, chatId: string): Context {
  // Создаем минимальный контекст для обработчика
  const update = {
    update_id: Date.now(),
    message: message,
  }

  const ctx = {
    update,
    updateType: 'message' as const,
    message: message,
    chat: {
      id: parseInt(chatId),
      type: 'channel' as const,
    },
    from: undefined,
  } as unknown as Context

  return ctx
}

/**
 * Останавливает мониторинг
 */
export async function stopChannelMonitoring() {
  const client = getTelegramClient()
  if (client && client.connected) {
    await client.disconnect()
    console.log('⏹ Остановлен мониторинг через Client API')
  }
}

