/**
 * Мониторинг каналов через Telegram Client API
 * Читает сообщения из каналов конкурентов и отправляет их боту для обработки
 */

import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions'
import { Api } from 'telegram/tl'

let monitoringClient: TelegramClient | null = null
let isMonitoring = false

/**
 * Инициализирует Client API клиент для мониторинга
 */
function getMonitoringClient(): TelegramClient | null {
  const apiId = process.env.TELEGRAM_API_ID
  const apiHash = process.env.TELEGRAM_API_HASH
  const sessionString = process.env.TELEGRAM_SESSION_STRING

  if (!apiId || !apiHash) {
    console.error('❌ TELEGRAM_API_ID или TELEGRAM_API_HASH не установлены')
    return null
  }

  if (!sessionString) {
    console.error('❌ TELEGRAM_SESSION_STRING не установлен')
    console.error('   Нужно сначала авторизоваться через QR-код')
    return null
  }

  if (monitoringClient) {
    return monitoringClient
  }

  const session = new StringSession(sessionString)
  monitoringClient = new TelegramClient(session, parseInt(apiId), apiHash, {
    connectionRetries: 5,
  })

  return monitoringClient
}

/**
 * Получает список каналов из базы данных через API основного приложения
 * Или использует переменную окружения с JSON списком каналов
 */
async function getChannelsToMonitor(): Promise<Array<{ chatId: string; title: string }>> {
  // Вариант 1: Получить из основного приложения через API
  const mainAppUrl = process.env.MAIN_APP_URL || process.env.VERCEL_URL || process.env.BOT_WEBHOOK_URL
  const apiKey = process.env.BOT_API_KEY || process.env.WORKER_API_KEY
  
  if (mainAppUrl && apiKey) {
    try {
      // Убираем /api/tg/webhook если есть
      const baseUrl = mainAppUrl.replace(/\/api\/tg\/webhook$/, '')
      const apiUrl = `${baseUrl}/api/channels`
      
      console.log(`   🔍 Получаю каналы из ${apiUrl}...`)
      
      const response = await fetch(apiUrl, {
        headers: {
          'Authorization': `Bearer ${apiKey}`
        }
      })
      
      if (response.ok) {
        const data = await response.json() as { channels?: Array<{ chatId: string; title: string }> }
        const channels = data.channels || []
        console.log(`   ✅ Получено ${channels.length} каналов из основного приложения`)
        return channels
      } else {
        console.warn(`   ⚠️ Ошибка получения каналов: ${response.status} ${response.statusText}`)
      }
    } catch (error: any) {
      console.warn('   ⚠️ Не удалось получить каналы из основного приложения:', error.message)
    }
  } else {
    console.warn('   ⚠️ MAIN_APP_URL или BOT_API_KEY не установлены')
  }

  // Вариант 2: Использовать переменную окружения
  const channelsEnv = process.env.MONITOR_CHANNELS
  if (channelsEnv) {
    try {
      const channels = JSON.parse(channelsEnv)
      console.log(`   ✅ Использую ${channels.length} каналов из MONITOR_CHANNELS`)
      return channels
    } catch (error) {
      console.error('   ❌ Ошибка парсинга MONITOR_CHANNELS:', error)
    }
  }

  // Вариант 3: Пустой список
  console.warn('   ⚠️ Каналы для мониторинга не найдены')
  console.warn('      Установите MONITOR_CHANNELS или настройте MAIN_APP_URL и BOT_API_KEY')
  return []
}

/**
 * Отправляет сообщение боту через webhook
 */
async function sendMessageToBot(message: any, chatId: string, channelTitle: string): Promise<void> {
  // Для локального тестирования можно использовать localhost
  const botWebhookUrl = process.env.BOT_WEBHOOK_URL || process.env.VERCEL_URL || process.env.MAIN_APP_URL || 'http://localhost:3000'
  if (!botWebhookUrl) {
    console.error('❌ BOT_WEBHOOK_URL не установлен, не могу отправить сообщение боту')
    return
  }
  
  // Убираем /api/tg/webhook если есть в URL
  const baseUrl = botWebhookUrl.replace(/\/api\/tg\/webhook$/, '')
  const webhookUrl = `${baseUrl}/api/tg/webhook`

  // Создаем update в формате Telegram Bot API
  const update = {
    update_id: Date.now(),
    message: {
      message_id: message.id,
      from: {
        id: 0, // Client API не предоставляет from для каналов
        is_bot: false,
      },
      chat: {
        id: parseInt(chatId),
        type: 'channel',
        title: channelTitle,
      },
      date: message.date ? Math.floor(message.date.getTime() / 1000) : Math.floor(Date.now() / 1000),
      forward_from_chat: {
        id: parseInt(chatId),
        type: 'channel',
        title: channelTitle,
      },
      text: message.message || '',
      caption: message.message || '',
    },
  }

  try {
    console.log(`   🔄 Отправляю сообщение боту на ${webhookUrl}...`)
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(update),
    })

    if (response.ok) {
      console.log(`   ✅ Сообщение отправлено боту через webhook`)
    } else {
      console.error(`   ❌ Ошибка отправки боту: ${response.status} ${response.statusText}`)
    }
  } catch (error: any) {
    console.error(`   ❌ Ошибка отправки боту: ${error.message}`)
  }
}

/**
 * Запускает мониторинг каналов
 */
export async function startMonitoring(): Promise<boolean> {
  if (isMonitoring) {
    console.log('⚠️ Мониторинг уже запущен')
    return true
  }

  const client = getMonitoringClient()
  if (!client) {
    return false
  }

  try {
    // Подключаемся к Telegram
    if (!client.connected) {
      await client.connect()
      console.log('✅ Подключен к Telegram через Client API')
    }

    // Получаем список каналов для мониторинга
    const channels = await getChannelsToMonitor()
    if (channels.length === 0) {
      console.warn('⚠️ Нет каналов для мониторинга')
      return false
    }

    console.log(`📡 Начинаю мониторинг ${channels.length} каналов...`)

    // Создаем Map для быстрого поиска каналов
    const channelsMap = new Map<string, string>()
    channels.forEach(ch => {
      channelsMap.set(ch.chatId, ch.title)
    })

    // Подписываемся на обновления
    client.addEventHandler(async (event: any) => {
      try {
        // Проверяем, что это сообщение из канала
        if (event.message && event.message.peerId) {
          const peerId = event.message.peerId

          // Преобразуем peerId в chatId
          let chatId: string | null = null

          if (peerId instanceof Api.PeerChannel) {
            chatId = `-100${peerId.channelId.toString()}`
          }

          if (chatId && channelsMap.has(chatId)) {
            const channelTitle = channelsMap.get(chatId) || 'Unknown'
            console.log(`📨 Получено сообщение из канала ${channelTitle} (${chatId})`)

            // Отправляем сообщение боту через webhook
            await sendMessageToBot(event.message, chatId, channelTitle)
          }
        }
      } catch (error) {
        console.error('❌ Ошибка обработки сообщения:', error)
      }
    })

    isMonitoring = true
    console.log('✅ Мониторинг каналов запущен')
    console.log(`   💡 Отслеживаю ${channels.length} каналов через Client API`)
    return true
  } catch (error: any) {
    console.error('❌ Ошибка запуска мониторинга:', error.message)
    return false
  }
}

/**
 * Останавливает мониторинг
 */
export async function stopMonitoring(): Promise<void> {
  if (!isMonitoring) {
    return
  }

  if (monitoringClient && monitoringClient.connected) {
    await monitoringClient.disconnect()
    monitoringClient = null
  }

  isMonitoring = false
  console.log('⏹ Мониторинг каналов остановлен')
}

/**
 * Проверяет статус мониторинга
 */
export function getMonitoringStatus(): { isMonitoring: boolean; isConnected: boolean } {
  return {
    isMonitoring,
    isConnected: monitoringClient?.connected || false,
  }
}

