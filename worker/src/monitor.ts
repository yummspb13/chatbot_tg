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
    // Увеличиваем таймауты для стабильности
    timeout: 10000,
    requestRetries: 3,
    retryDelay: 2000,
  })

  return monitoringClient
}

/**
 * Получает список каналов напрямую из базы данных через Prisma
 * Или использует переменную окружения с JSON списком каналов
 */
async function getChannelsToMonitor(): Promise<Array<{ chatId: string; title: string }>> {
  // Вариант 1: Получить напрямую из БД через Prisma (ПРИОРИТЕТ)
  const databaseUrl = process.env.DATABASE_URL
  if (databaseUrl) {
    try {
      // Динамически импортируем Prisma только если DATABASE_URL есть
      const { PrismaClient } = await import('@prisma/client')
      const prisma = new PrismaClient()
      
      console.log('   🔍 Получаю каналы напрямую из базы данных...')
      
      const channels = await prisma.channel.findMany({
        where: {
          isActive: true,
        },
        select: {
          chatId: true,
          title: true,
        },
        orderBy: {
          title: 'asc',
        },
      })
      
      await prisma.$disconnect()
      
      if (channels.length > 0) {
        console.log(`   ✅ Получено ${channels.length} каналов из базы данных`)
        return channels.map((ch: { chatId: string; title: string }) => ({
          chatId: ch.chatId,
          title: ch.title,
        }))
      } else {
        console.warn('   ⚠️ В базе данных нет активных каналов')
      }
    } catch (error: any) {
      console.warn('   ⚠️ Не удалось получить каналы из БД:', error.message)
      // Продолжаем к следующим вариантам
    }
  } else {
    console.warn('   ⚠️ DATABASE_URL не установлен, пропускаю прямой доступ к БД')
  }

  // Вариант 2: Получить из основного приложения через API (fallback)
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
  }

  // Вариант 3: Использовать переменную окружения
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

  // Вариант 4: Пустой список
  console.warn('   ⚠️ Каналы для мониторинга не найдены')
  console.warn('      Установите DATABASE_URL, MONITOR_CHANNELS или настройте MAIN_APP_URL и BOT_API_KEY')
  return []
}

/**
 * Отправляет сообщение боту через webhook
 */
async function sendMessageToBot(message: any, chatId: string, channelTitle: string): Promise<void> {
  // Используем MAIN_APP_URL как основной источник, затем BOT_WEBHOOK_URL, затем VERCEL_URL
  let botWebhookUrl = process.env.MAIN_APP_URL || process.env.BOT_WEBHOOK_URL || process.env.VERCEL_URL || 'http://localhost:3000'
  if (!botWebhookUrl) {
    console.error('❌ BOT_WEBHOOK_URL не установлен, не могу отправить сообщение боту')
    return
  }
  
  // Автоматически добавляем https:// если его нет (но не для localhost)
  if (!botWebhookUrl.startsWith('http://') && !botWebhookUrl.startsWith('https://')) {
    botWebhookUrl = `https://${botWebhookUrl}`
    console.log(`   💡 Добавлен https:// к MAIN_APP_URL: ${botWebhookUrl}`)
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

  // Извлекаем информацию о фотографиях из сообщения
  // ВАЖНО: Telegram Client API и Bot API используют разные форматы file_id
  // Мы скачиваем файлы через Client API и передаем их как base64 или сохраняем оригинальную информацию
  let photo: any[] | undefined = undefined
  let document: any | undefined = undefined
  let photoBuffers: Array<{ index: number; buffer: Buffer; mimeType: string }> = []
  
  if (message.media) {
    const media = message.media as any
    console.log(`   🔍 Проверяю медиа в сообщении...`)
    console.log(`   🔍 Media type: ${media.constructor?.name || typeof media}`)
    
    // Проверяем, есть ли фото
    if (media.photo) {
      try {
        const photoObj = media.photo as any
        // Telegram Client API Photo содержит sizes - массив размеров
        const photoSizes = photoObj.sizes || []
        console.log(`   🖼 Найдено фото: ${photoSizes.length} размеров`)
        
        if (photoSizes.length > 0) {
          // Берем самое большое изображение (последний элемент)
          const largestPhoto = photoSizes[photoSizes.length - 1]
          
          // Скачиваем фото через Client API
          const client = getMonitoringClient()
          if (client) {
            try {
              console.log(`   🖼 Скачиваю фото через Client API...`)
              const buffer = await client.downloadMedia(message, {
                thumb: -1, // Берем самое большое изображение
              }) as Buffer
              
              if (buffer) {
                console.log(`   🖼 ✅ Фото скачано: ${buffer.length} bytes`)
                photoBuffers.push({
                  index: 0,
                  buffer,
                  mimeType: 'image/jpeg', // Telegram обычно возвращает JPEG
                })
                
                // Создаем временный file_id для передачи в webhook
                // В handleApprove мы будем использовать buffer для загрузки в Cloudinary
                photo = [{
                  file_id: `client_api_photo_${Date.now()}`,
                  file_unique_id: `client_api_photo_${Date.now()}`,
                  width: largestPhoto.w || 0,
                  height: largestPhoto.h || 0,
                  file_size: buffer.length,
                  _clientApiBuffer: buffer.toString('base64'), // Сохраняем как base64 для передачи
                }]
                console.log(`   🖼 ✅ Фото подготовлено для передачи (base64: ${buffer.length} bytes)`)
              }
            } catch (downloadError: any) {
              console.warn(`   ⚠️ Ошибка скачивания фото: ${downloadError.message}`)
              // Если не удалось скачать, передаем информацию о наличии фото
              const location = largestPhoto.location
              const tempId = location 
                ? `${location.volumeId}_${location.localId}` 
                : `temp_${Date.now()}`
              photo = [{
                file_id: tempId,
                file_unique_id: tempId,
                width: largestPhoto.w || 0,
                height: largestPhoto.h || 0,
                file_size: largestPhoto.s || 0,
                _clientApiLocation: location,
              }]
            }
          }
        }
      } catch (error: any) {
        console.warn(`   ⚠️ Ошибка извлечения фото: ${error.message}`)
        console.warn(`   ⚠️ Stack: ${error.stack?.substring(0, 200)}`)
      }
    }
    
    // Проверяем, есть ли document (может быть изображением)
    if (media.document) {
      const doc = media.document as any
      const mimeType = doc.mimeType || ''
      console.log(`   🔍 Найден document: ${mimeType}`)
      
      if (mimeType.startsWith('image/')) {
        // Скачиваем document через Client API
        const client = getMonitoringClient()
        if (client) {
          try {
            console.log(`   🖼 Скачиваю document-изображение через Client API...`)
            const buffer = await client.downloadMedia(message) as Buffer
            
            if (buffer) {
              console.log(`   🖼 ✅ Document скачан: ${buffer.length} bytes`)
              document = {
                file_id: `client_api_doc_${Date.now()}`,
                file_unique_id: `client_api_doc_${Date.now()}`,
                file_name: doc.attributes?.find((attr: any) => attr.fileName)?.fileName || '',
                mime_type: mimeType,
                file_size: buffer.length,
                _clientApiBuffer: buffer.toString('base64'), // Сохраняем как base64
              }
              console.log(`   🖼 ✅ Document подготовлен для передачи`)
            }
          } catch (downloadError: any) {
            console.warn(`   ⚠️ Ошибка скачивания document: ${downloadError.message}`)
            document = {
              file_id: doc.id?.toString() || `doc_${Date.now()}`,
              file_unique_id: doc.id?.toString() || `doc_${Date.now()}`,
              file_name: doc.attributes?.find((attr: any) => attr.fileName)?.fileName || '',
              mime_type: mimeType,
              file_size: doc.size || 0,
              _clientApiDocument: doc,
            }
          }
        }
      }
    }
  } else {
    console.log(`   🔍 Медиа в сообщении не найдено`)
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
      ...(photo && photo.length > 0 ? { photo } : {}),
      ...(document ? { document } : {}),
    },
  }

  try {
    console.log(`   🔄 Отправляю сообщение боту на ${webhookUrl}...`)
    console.log(`   📤 Update payload:`, JSON.stringify(update, null, 2).substring(0, 500))
    
    // Добавляем timeout для fetch (увеличиваем до 30 секунд, т.к. Vercel может долго обрабатывать)
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 30000) // 30 секунд timeout
    
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(update),
      signal: controller.signal,
    })

    clearTimeout(timeoutId)

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
    // Улучшенная обработка ошибок
    if (error.name === 'AbortError') {
      console.error(`   ❌ Ошибка отправки боту: Timeout (10s) - сервер не отвечает`)
      console.error(`   💡 Проверьте, что Next.js сервер запущен на ${webhookUrl}`)
    } else if (error.code === 'ECONNREFUSED') {
      console.error(`   ❌ Ошибка отправки боту: Connection refused`)
      console.error(`   💡 Сервер недоступен. Убедитесь, что Next.js сервер запущен:`)
      console.error(`      - Для локальной разработки: npm run dev`)
      console.error(`      - URL: ${webhookUrl}`)
    } else if (error.code === 'ENOTFOUND') {
      console.error(`   ❌ Ошибка отправки боту: Host not found`)
      console.error(`   💡 Не удалось найти хост. Проверьте URL: ${webhookUrl}`)
    } else {
      console.error(`   ❌ Ошибка отправки боту: ${error.message}`)
      console.error(`   ❌ Error code: ${error.code || 'N/A'}`)
      console.error(`   ❌ Error name: ${error.name || 'N/A'}`)
      if (error.cause) {
        console.error(`   ❌ Error cause: ${error.cause}`)
      }
      if (error.stack) {
        console.error(`   ❌ Stack: ${error.stack.substring(0, 300)}`)
      }
    }
    console.error(`   🔍 Webhook URL: ${webhookUrl}`)
    console.error(`   🔍 Environment: MAIN_APP_URL=${process.env.MAIN_APP_URL || 'not set'}, BOT_WEBHOOK_URL=${process.env.BOT_WEBHOOK_URL || 'not set'}`)
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
      console.log('   🔌 Подключаюсь к Telegram...')
      try {
        await client.connect()
        console.log('✅ Подключен к Telegram через Client API')
      } catch (error: any) {
        if (error.errorMessage?.includes('AUTH_KEY_DUPLICATED') || 
            error.message?.includes('AUTH_KEY_DUPLICATED') ||
            error.errorMessage?.includes('406')) {
          console.error('   ❌ ОШИБКА: AUTH_KEY_DUPLICATED')
          console.error('   ⚠️ Сессия используется одновременно в нескольких местах!')
          console.error('   💡 Решения:')
          console.error('      1. Остановите локальный Worker (если запущен)')
          console.error('      2. Проверьте, не запущено ли несколько инстансов на Render.com')
          console.error('      3. Создайте новую сессию через QR-код')
          console.error('   📖 Подробнее: см. FIX_AUTH_KEY_DUPLICATED.md')
          throw error
        }
        throw error
      }
    } else {
      console.log('   ✅ Уже подключен к Telegram')
    }
    
    // Проверяем, что соединение действительно работает
    try {
      await client.getMe()
      console.log('   ✅ Соединение с Telegram подтверждено (getMe успешен)')
    } catch (error: any) {
      console.warn('   ⚠️ Предупреждение: getMe не удался, но продолжаю:', error.message)
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
    console.log('   📡 Ожидаю события: UpdateNewMessage, UpdateNewChannelMessage')
    console.log('')
    
    // ВАЖНО: Удаляем старые обработчики перед добавлением нового
    // Это предотвращает дублирование обработчиков после перезапуска
    try {
      // Очищаем все существующие обработчики
      if ((client as any)._eventBuilders) {
        (client as any)._eventBuilders = []
        console.log('   🧹 Очищены старые обработчики событий')
      }
    } catch (e) {
      // Игнорируем ошибки при очистке
    }
    
    // Обработчик для новых сообщений из каналов
    // Используем фильтр для более эффективной обработки
    const eventHandler = async (event: any) => {
      const logPrefix = `[${new Date().toISOString()}]`
      const eventType = event.constructor.name
      
      // Логируем ВСЕ события для диагностики
      console.log(`${logPrefix} 📥 EVENT: ${eventType}`)
      
      // Проверяем, что это событие нового сообщения
      const isNewMessage = event instanceof Api.UpdateNewMessage
      const isNewChannelMessage = event instanceof Api.UpdateNewChannelMessage
      
      if (!isNewMessage && !isNewChannelMessage) {
        // Логируем другие события для диагностики (но не обрабатываем)
        if (eventType.includes('Message') || eventType.includes('Update') || eventType.includes('Channel')) {
          console.log(`${logPrefix}   ⚠️ Пропускаю событие типа ${eventType}`)
          // Для важных событий выводим больше информации (без JSON.stringify, т.к. могут быть циклические ссылки)
          if (eventType.includes('Connection') || eventType.includes('State')) {
            // Безопасная сериализация - только основные поля
            try {
              const safeEvent = {
                constructor: eventType,
                _: (event as any)._?.constructor?.name || 'unknown',
              }
              console.log(`${logPrefix}   🔍 Connection/State event:`, safeEvent)
            } catch (e) {
              // Если даже это не работает, просто логируем тип
              console.log(`${logPrefix}   🔍 Connection/State event: ${eventType}`)
            }
          }
        }
        return
      }
      
      console.log(`${logPrefix}   ✅ Это событие нового сообщения (${isNewMessage ? 'UpdateNewMessage' : 'UpdateNewChannelMessage'})`)
      
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
    }
    
    // Регистрируем обработчик для всех событий
    // Внутри обработчика проверяем тип события
    client.addEventHandler(eventHandler)
    
    // Также регистрируем обработчик для Connection/State событий (для диагностики)
    client.addEventHandler(async (event: any) => {
      const logPrefix = `[${new Date().toISOString()}]`
      const eventType = event.constructor.name
      
      // Логируем только важные события для диагностики
      if (eventType.includes('Connection') || eventType.includes('State')) {
        console.log(`${logPrefix} 📡 Connection/State: ${eventType}`)
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


