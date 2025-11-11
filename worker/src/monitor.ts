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

  console.log('   [getMonitoringClient] Проверка переменных окружения...')
  console.log(`   [getMonitoringClient] TELEGRAM_API_ID: ${apiId ? '✅' : '❌'}`)
  console.log(`   [getMonitoringClient] TELEGRAM_API_HASH: ${apiHash ? '✅' : '❌'}`)
  console.log(`   [getMonitoringClient] TELEGRAM_SESSION_STRING: ${sessionString ? '✅' : '❌'}`)

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
  // Используем MAIN_APP_URL как основной источник, затем BOT_WEBHOOK_URL, затем VERCEL_URL
  const botWebhookUrl = process.env.MAIN_APP_URL || process.env.BOT_WEBHOOK_URL || process.env.VERCEL_URL || 'http://localhost:3000'
  if (!botWebhookUrl) {
    console.error('❌ BOT_WEBHOOK_URL не установлен, не могу отправить сообщение боту')
    return
  }
  
  // Убираем /api/tg/webhook если есть в URL
  const baseUrl = botWebhookUrl.replace(/\/api\/tg\/webhook$/, '')
  const webhookUrl = `${baseUrl}/api/tg/webhook`

  // Создаем update в формате Telegram Bot API
  // message.date может быть Date объектом, числом (timestamp) или другим типом
  let messageDate: number
  try {
    if (message.date) {
      // Проверяем тип message.date
      if (message.date instanceof Date) {
        messageDate = Math.floor(message.date.getTime() / 1000)
      } else if (typeof message.date === 'number') {
        // Если это уже timestamp в секундах
        messageDate = message.date
      } else if (typeof message.date === 'string') {
        // Если это строка, пытаемся распарсить
        const parsed = new Date(message.date)
        messageDate = isNaN(parsed.getTime()) ? Math.floor(Date.now() / 1000) : Math.floor(parsed.getTime() / 1000)
      } else {
        // Для любых других типов используем текущее время
        console.warn(`   ⚠️ Неожиданный тип message.date: ${typeof message.date}, значение: ${message.date}`)
        messageDate = Math.floor(Date.now() / 1000)
      }
    } else {
      messageDate = Math.floor(Date.now() / 1000)
    }
  } catch (error: any) {
    console.error(`   ❌ Ошибка обработки message.date: ${error.message}`)
    console.error(`   message.date type: ${typeof message.date}, value: ${message.date}`)
    messageDate = Math.floor(Date.now() / 1000)
  }

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
      date: messageDate,
      forward_from_chat: {
        id: parseInt(chatId),
        type: 'channel',
        title: channelTitle,
      },
      text: message.message || message.text || '',
      caption: message.message || message.text || (message.media && (message.media as any).caption) || '',
    },
  }

  try {
    console.log(`   🔄 Отправляю сообщение боту на ${webhookUrl}...`)
    console.log(`   📤 Update payload:`, JSON.stringify(update, null, 2).substring(0, 500))
    
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(update),
    })

    const responseText = await response.text()
    console.log(`   📥 Response status: ${response.status} ${response.statusText}`)
    console.log(`   📥 Response body: ${responseText.substring(0, 200)}`)

    if (response.ok) {
      console.log(`   ✅ Сообщение отправлено боту через webhook`)
    } else {
      console.error(`   ❌ Ошибка отправки боту: ${response.status} ${response.statusText}`)
      console.error(`   ❌ Response: ${responseText}`)
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
    console.log(`   📋 Список каналов:`)
    channels.forEach(ch => {
      console.log(`      - ${ch.title} (${ch.chatId})`)
    })

    // Создаем Map для быстрого поиска каналов
    const channelsMap = new Map<string, string>()
    channels.forEach(ch => {
      channelsMap.set(ch.chatId, ch.title)
    })
    console.log(`   ✅ Channels map создан, размер: ${channelsMap.size}`)

    // Подписываемся на обновления новых сообщений
    console.log('   📡 Регистрирую обработчик событий для новых сообщений...')
    
    // Обработчик для новых сообщений из каналов
    client.addEventHandler(async (event: any) => {
      const logPrefix = `[${new Date().toISOString()}]`
      console.log(`${logPrefix} 📥 EVENT: ${event.constructor.name}`)
      
      // Проверяем, что это событие нового сообщения
      if (!(event instanceof Api.UpdateNewMessage || event instanceof Api.UpdateNewChannelMessage)) {
        // Пропускаем другие события
        return
      }
      
      try {
        // Получаем сообщение из события
        const message = (event as any).message
        if (!message) {
          console.log(`${logPrefix}   ⚠️ Event has no message property`)
          return
        }

        console.log(`${logPrefix}   ✅ Event has message`)
        console.log(`${logPrefix}   Message ID: ${message.id}`)
        console.log(`${logPrefix}   Message peerId: ${message.peerId ? message.peerId.constructor.name : 'null'}`)
        
        if (message.peerId) {
          const peerId = message.peerId

          // Преобразуем peerId в chatId
          let chatId: string | null = null

          if (peerId instanceof Api.PeerChannel) {
            chatId = `-100${peerId.channelId.toString()}`
            console.log(`${logPrefix}   PeerChannel ID: ${peerId.channelId}, chatId: ${chatId}`)
          } else {
            console.log(`${logPrefix}   ⚠️ peerId is not PeerChannel: ${peerId.constructor.name}`)
            return
          }

          if (chatId) {
            console.log(`${logPrefix}   Checking if chatId ${chatId} is in channelsMap...`)
            console.log(`${logPrefix}   Channels in map: ${Array.from(channelsMap.keys()).join(', ')}`)
            
            if (channelsMap.has(chatId)) {
              const channelTitle = channelsMap.get(chatId) || 'Unknown'
              console.log(`${logPrefix} 📨 Получено сообщение из канала ${channelTitle} (${chatId})`)

              // Логируем структуру message для отладки
              console.log(`${logPrefix}   🔍 Debug: message.date type: ${typeof message.date}, value: ${message.date}`)
              if (message.date) {
                console.log(`${logPrefix}   🔍 Debug: message.date instanceof Date: ${message.date instanceof Date}`)
              }

              // Получаем текст сообщения
              let messageText = ''
              if (message.message) {
                messageText = message.message
              } else if (message.media) {
                // Если есть медиа, используем caption
                if ((message.media as any).caption) {
                  messageText = (message.media as any).caption
                }
              }
              console.log(`${logPrefix}   Message text length: ${messageText.length}`)

              // Отправляем сообщение боту через webhook
              await sendMessageToBot(message, chatId, channelTitle)
            } else {
              console.log(`${logPrefix}   ⚠️ ChatId ${chatId} не найден в списке мониторинга`)
            }
          }
        } else {
          console.log(`${logPrefix}   ⚠️ Message has no peerId`)
        }
      } catch (error: any) {
        console.error(`${logPrefix} ❌ Ошибка обработки сообщения:`, error)
        console.error(`${logPrefix}   Stack:`, error.stack)
        if ((event as any).message) {
          console.error(`${logPrefix}   Message object:`, JSON.stringify((event as any).message, null, 2).substring(0, 500))
        }
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


