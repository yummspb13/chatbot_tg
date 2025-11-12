import { Context } from 'telegraf'
import { prisma } from '@/lib/db/prisma'
import { getBotSettings } from './bot'
import { classifyMessage } from '@/lib/openai/classifier'
import { extractEvent } from '@/lib/openai/extractor'
import { predictDecision } from '@/lib/openai/agent'
import { formatTelegramLink } from '@/lib/afisha/client'
import { parseISOString, formatMoscowDate } from '@/lib/utils/date'
import { getBot } from './bot'
import { extractLinks } from '@/lib/utils/link-extractor'
import { geocodeVenue } from '@/lib/utils/geocoding'

// Включаем логирование всех запросов к Prisma
if (process.env.DEBUG_PRISMA === 'true') {
  // Prisma query logging (только для отладки)
  // @ts-ignore - Prisma $on может не иметь типов для query в некоторых версиях
  prisma.$on('query', (e: any) => {
    console.log('      [Prisma] Query:', e.query)
    console.log('      [Prisma] Params:', e.params)
    console.log('      [Prisma] Duration:', e.duration, 'ms')
  })
}

/**
 * Извлекает изображения из сообщения Telegram
 */
function extractImagesFromMessage(message: any): string[] {
  const images: string[] = []

  // Обрабатываем photo (массив размеров)
  if (message.photo && Array.isArray(message.photo) && message.photo.length > 0) {
    // Берем самое большое изображение (последний элемент)
    const largestPhoto = message.photo[message.photo.length - 1]
    if (largestPhoto?.file_id) {
      // Получаем прямую ссылку на файл через Telegram Bot API
      // В реальности нужно использовать getFile API для получения file_path
      // Для MVP сохраняем file_id, который можно использовать позже
      images.push(largestPhoto.file_id)
    }
  }

  // Обрабатываем document (если это изображение)
  if (message.document) {
    const mimeType = message.document.mime_type || ''
    if (mimeType.startsWith('image/')) {
      if (message.document.file_id) {
        images.push(message.document.file_id)
      }
    }
  }

  return images
}

/**
 * Получает прямую ссылку на файл из Telegram
 */
async function getTelegramFileUrl(fileId: string): Promise<string | null> {
  console.log('         [Telegram] Получаю информацию о файле, file_id:', fileId)
  
  // Проверяем, не является ли это временным file_id от Worker (Client API)
  // Временные file_id имеют формат: volumeId_localId_index или temp_timestamp_index
  if (fileId.startsWith('temp_') || fileId.match(/^\d+_\d+_\d+$/)) {
    console.log('         [Telegram] ⚠️ Это временный file_id от Worker (Client API)')
    console.log('         [Telegram] ⚠️ Временные file_id не работают с Bot API')
    console.log('         [Telegram] ⚠️ Нужно скачивать файлы через Client API в Worker')
    return null
  }
  
  try {
    const bot = getBot()
    const file = await bot.telegram.getFile(fileId)
    console.log('         [Telegram] Информация о файле получена:', file.file_path ? 'есть путь' : 'нет пути')
    
    if (file.file_path) {
      const token = process.env.TELEGRAM_BOT_TOKEN
      const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`
      console.log('         [Telegram] ✅ URL файла сформирован:', url.substring(0, 80) + '...')
      return url
    } else {
      console.log('         [Telegram] ⚠️ file_path отсутствует в ответе')
    }
  } catch (error: any) {
    // Обрабатываем ошибку invalid file_id
    if (error.response?.description?.includes('invalid file_id') || 
        error.message?.includes('invalid file_id') ||
        error.response?.error_code === 400) {
      console.error('         [Telegram] ❌ Ошибка: invalid file_id')
      console.error('         [Telegram] ⚠️ Это может быть временный file_id от Worker (Client API)')
      console.error('         [Telegram] ⚠️ Временные file_id не работают с Bot API')
      console.error('         [Telegram] ⚠️ Нужно скачивать файлы через Client API в Worker')
    } else {
      console.error('         [Telegram] ❌ Ошибка получения URL файла:', error.message || error)
    console.error('         [Telegram] Stack trace:', error instanceof Error ? error.stack : 'нет stack trace')
    }
  }
  return null
}

/**
 * Обрабатывает новое сообщение из канала
 */
import { memoryLogger } from '@/lib/logging/memory-logger'

export async function handleChannelMessage(ctx: Context) {
  const logPrefix = `[${new Date().toISOString()}]`
  
  console.log('')
  console.log('═══════════════════════════════════════════════════════════')
  console.log('🔵 handleChannelMessage ВЫЗВАН')
  console.log('   Update Type:', ctx.updateType)
  console.log('   Chat Type:', ctx.chat?.type)
  console.log('   Chat ID:', ctx.chat?.id)
  console.log('   Has message:', !!ctx.message)
  console.log('   Has channelPost:', !!(ctx as any).channelPost)
  console.log('   Has editedChannelPost:', !!(ctx as any).editedChannelPost)
  console.log('   Full update keys:', Object.keys(ctx.update || {}))
  
  memoryLogger.info(
    'handleChannelMessage ВЫЗВАН',
    {
      updateType: ctx.updateType,
      chatType: ctx.chat?.type,
      chatId: ctx.chat?.id,
      hasMessage: !!ctx.message,
      hasChannelPost: !!(ctx as any).channelPost,
    },
    'messageHandler'
  )
  
  // Поддерживаем все возможные типы сообщений из каналов:
  // - message (если приходит как message)
  // - channelPost (основной тип)
  // - editedChannelPost (отредактированные)
  // - editedMessage (если приходит как edited_message)
  const message = ctx.message || 
                  (ctx as any).channelPost || 
                  (ctx as any).editedChannelPost ||
                  (ctx as any).editedMessage
  
  if (!message) {
    console.log('   ❌ НЕТ message в ctx, выхожу')
    console.log('   ctx.message:', ctx.message)
    console.log('   ctx.channelPost:', (ctx as any).channelPost)
    console.log('   ctx.editedChannelPost:', (ctx as any).editedChannelPost)
    console.log('   ctx.editedMessage:', (ctx as any).editedMessage)
    console.log('   Полный update для анализа:')
    console.log('   ', JSON.stringify(ctx.update, null, 2).substring(0, 1000))
    console.log('═══════════════════════════════════════════════════════════')
    console.log('')
    return
  }
  
  console.log('   ✅ Message найден')
  console.log('   Message ID:', message.message_id)
  console.log('   Message keys:', Object.keys(message))

  // Извлекаем текст сообщения (может быть в разных полях)
  let text = ''
  if ('text' in message && message.text) {
    text = message.text
  } else if ('caption' in message && message.caption) {
    text = message.caption
  }

  // Если нет текста и нет изображений, пропускаем
  const images = extractImagesFromMessage(message)
  console.log('   🖼 Изображений найдено:', images.length)
  if (images.length > 0) {
    console.log('   🖼 File IDs:', images)
    console.log('   🖼 Message photo:', message.photo ? `есть (${message.photo.length} размеров)` : 'нет')
    console.log('   🖼 Message document:', message.document ? `есть (${message.document.mime_type || 'unknown'})` : 'нет')
  }
  if (!text && images.length === 0) {
    console.log('   ⏭ Пропущено: нет текста и нет изображений')
    return // Пропускаем сообщения без текста и изображений
  }
  
  console.log('   📝 Текст сообщения:', text.substring(0, 200) || 'нет текста')
  console.log('   🖼 Изображений:', images.length)

  const chatId = ctx.chat?.id?.toString()
  if (!chatId) {
    console.log('   ❌ НЕТ chatId, выхожу')
    console.log('   ctx.chat:', ctx.chat)
    console.log('═══════════════════════════════════════════════════════════')
    console.log('')
    return
  }
  console.log('   ✅ Chat ID получен:', chatId)

  // Проверяем, что это канал из нашей базы
  console.log('   🔍 Проверяю канал в базе данных...')
  memoryLogger.info(
    `STEP1: FIND_CHANNEL_IN_DB - Ищу канал с chatId: ${chatId}`,
    { chatId },
    'messageHandler'
  )
  const channel = await prisma.channel.findFirst({
    where: {
      chatId,
      isActive: true,
    },
    include: {
      city: true,
    },
  })

  if (!channel) {
    console.log(`   ❌ Канал ${chatId} не найден в базе или неактивен`)
    console.log('   💡 Проверьте:')
    console.log('      1. Канал добавлен через /addchannel?')
    console.log('      2. Канал активен (isActive = true)?')
    console.log('      3. Chat ID правильный?')
    console.log('      4. Бот добавлен в канал как администратор?')
    
    // Показываем все каналы для отладки
    const allChannels = await prisma.channel.findMany({
      select: { chatId: true, title: true, isActive: true }
    })
    console.log('   📋 Все каналы в базе:')
    allChannels.forEach(ch => {
      console.log(`      - ${ch.title} (${ch.chatId}) - ${ch.isActive ? 'активен' : 'неактивен'}`)
    })
    
    console.log('═══════════════════════════════════════════════════════════')
    console.log('')
    return // Канал не отслеживается
  }
  console.log(`   ✅ Канал найден: "${channel.title}" (ID: ${channel.id})`)
  memoryLogger.info(`Канал найден в базе`, { channelId: channel.id, channelTitle: channel.title, chatId }, 'messageHandler')

  // Проверяем, что бот запущен
  console.log('   🔍 Проверяю статус бота...')
  memoryLogger.info(`Проверка статуса бота`, {}, 'messageHandler')
  const settings = await getBotSettings()
  console.log('   📊 Настройки бота:', {
    isRunning: settings.isRunning,
    mode: settings.mode,
    confidenceThreshold: settings.confidenceThreshold
  })
  memoryLogger.info(`Настройки бота получены`, { isRunning: settings.isRunning, mode: settings.mode }, 'messageHandler')
  
  if (!settings.isRunning) {
    console.log(`   ❌ Бот не запущен (isRunning = false), пропускаю сообщение из канала ${channel.title}`)
    console.log('   💡 Запустите бота командой /start')
    memoryLogger.warn(`Бот не запущен, сообщение пропущено`, { chatId, channelTitle: channel.title }, 'messageHandler')
    console.log('═══════════════════════════════════════════════════════════')
    console.log('')
    return
  }
  console.log('   ✅ Бот запущен')
  memoryLogger.info(`Бот запущен, продолжаю обработку`, {}, 'messageHandler')
  
  console.log(`   📨 Получено сообщение из канала: ${channel.title} (${chatId})`)

  const messageId = message.message_id.toString()
  console.log('   📝 Message ID:', messageId)
  memoryLogger.info(`Проверка дубликатов`, { messageId, chatId }, 'messageHandler')
  // text уже извлечен выше из message.text или message.caption

  // Проверяем, не обрабатывали ли мы уже это сообщение
  console.log('   🔍 Проверяю на дубликаты...')
  const existingDraft = await prisma.draftEvent.findFirst({
    where: {
      telegramMessageId: messageId,
      telegramChatId: chatId,
    },
  })

  if (existingDraft) {
    console.log('   ⏭ Сообщение уже обработано (черновик существует, ID:', existingDraft.id, ')')
    memoryLogger.warn(`Сообщение уже обработано`, { messageId, chatId, draftId: existingDraft.id }, 'messageHandler')
    console.log('═══════════════════════════════════════════════════════════')
    console.log('')
    return // Уже обработано
  }
  console.log('   ✅ Дубликатов не найдено, продолжаю обработку')
  memoryLogger.info(`Дубликатов не найдено, начинаю обработку`, { messageId, chatId }, 'messageHandler')

  // Сохраняем оригинальный текст для обучения (во временное хранилище или прямо в DraftEvent)
  // Для MVP сохраним в description если его нет, или создадим отдельное поле позже

  try {
    // Объявляем logPrefix один раз для всего блока try
    const getLogPrefix = () => `[${new Date().toISOString()}]`
    
    console.log('   🔄 Начинаю обработку сообщения...')
    
    // 1. Классификация
    console.log(`${getLogPrefix()} 📊 STEP1: CLASSIFICATION`)
    const category = await classifyMessage(text)
    console.log(`${getLogPrefix()} 📊 RESULT: ${category}`)
    if (category === 'AD') {
      console.log(`${getLogPrefix()} ⏭ SKIP: AD detected`)
      return // Пропускаем рекламу
    }

    // 2. Извлечение полей
    console.log(`${getLogPrefix()} 📝 STEP2: EXTRACTION`)
    const messageDate = new Date(message.date * 1000)
    console.log(`${getLogPrefix()} 📅 Message date: ${messageDate.toISOString()}`)
    const extracted = await extractEvent(text, messageDate)
    console.log(`${getLogPrefix()} 📝 EXTRACTED: title=${extracted.title ? 'YES' : 'NO'} startDate=${extracted.startDateIso ? 'YES' : 'NO'}`)

    if (!extracted.title || !extracted.startDateIso) {
      console.log(`${getLogPrefix()} ❌ SKIP: Missing required fields`)
      console.log(`${getLogPrefix()} ❌ Title: ${extracted.title || 'MISSING'}, StartDate: ${extracted.startDateIso || 'MISSING'}`)
      return // Пропускаем, если нет обязательных полей
    }
    console.log(`${getLogPrefix()} ✅ REQUIRED FIELDS: OK`)

    // 3. Проверка дубликатов
    console.log('   🔍 Шаг 3: Проверка дубликатов...')
    const startDate = parseISOString(extracted.startDateIso)
    console.log('   📅 Парсинг даты:', extracted.startDateIso, '->', startDate.toISOString())
    
    const duplicate = await prisma.draftEvent.findFirst({
      where: {
        title: {
          equals: extracted.title,
          mode: 'insensitive',
        },
        startDate: {
          equals: startDate,
        },
      },
    })

    if (duplicate) {
      console.log(`   ⏭ Дубликат найден для "${extracted.title}" на ${extracted.startDateIso}`)
      return
    }
    console.log('   ✅ Дубликатов не найдено')

    // 4. Предсказание агента
    console.log('   🤖 Шаг 4: Предсказание агента...')
    const agentPrediction = await predictDecision(text, extracted)
    console.log('   🤖 Результат агента:', JSON.stringify(agentPrediction, null, 2))

    // 4.5. Обработка изображений
    console.log('   🖼 Шаг 4.5: Обработка изображений...')
    memoryLogger.info(`Обработка изображений`, { messageId, chatId }, 'messageHandler')
    
    let coverImageUrl: string | null = null
    const galleryUrls: string[] = []

    // Проверяем, есть ли base64 буферы от Worker (Client API)
    const photoBuffers: Array<{ index: number; data: string; mimeType: string }> = []
    if (message.photo && Array.isArray(message.photo)) {
      console.log(`   🖼 Найдено photo в message: ${message.photo.length} элементов`)
      memoryLogger.info(`Найдено photo в message`, { count: message.photo.length, messageId, chatId }, 'messageHandler')
      
      for (const photoItem of message.photo) {
        if (photoItem._clientApiBuffer) {
          photoBuffers.push({
            index: photoItem.file_id?.includes('_0') ? 0 : photoBuffers.length,
            data: photoItem._clientApiBuffer,
            mimeType: 'image/jpeg',
          })
          console.log(`   🖼 Найден base64 буфер от Worker (${photoItem._clientApiBuffer.length} символов)`)
          memoryLogger.info(`Найден base64 буфер от Worker`, { 
            bufferLength: photoItem._clientApiBuffer.length, 
            messageId, 
            chatId 
          }, 'messageHandler')
        } else {
          console.log(`   🖼 Photo элемент без _clientApiBuffer:`, photoItem.file_id || 'нет file_id')
        }
      }
    } else {
      console.log(`   🖼 Photo в message отсутствует или не массив`)
      memoryLogger.info(`Photo в message отсутствует`, { messageId, chatId }, 'messageHandler')
    }
    
    // Если есть base64 буферы, сохраняем их для загрузки в Cloudinary при одобрении
    // НЕ загружаем в Cloudinary сейчас - только при одобрении!
    if (photoBuffers.length > 0) {
      console.log(`   🖼 Найдено ${photoBuffers.length} base64 буферов от Worker`)
      console.log(`   🖼 ⚠️ Изображения НЕ загружаются в Cloudinary сейчас - только при одобрении!`)
      memoryLogger.info(`Найдены base64 буферы от Worker`, { 
        count: photoBuffers.length, 
        messageId, 
        chatId 
      }, 'messageHandler')
      
      // Сохраняем base64 буферы в coverImage и gallery как JSON
      // В handleApprove мы будем использовать их для загрузки в Cloudinary
      if (photoBuffers.length > 0) {
        // Первое изображение - coverImage (сохраняем как base64)
        coverImageUrl = `base64:${photoBuffers[0].data}`
        console.log(`   🖼 ✅ Cover image сохранен как base64 (${photoBuffers[0].data.length} символов)`)
        memoryLogger.success(`Cover image сохранен как base64`, { 
          bufferLength: photoBuffers[0].data.length, 
          messageId, 
          chatId 
        }, 'messageHandler')
        
        // Остальные - gallery
        for (let i = 1; i < photoBuffers.length; i++) {
          galleryUrls.push(`base64:${photoBuffers[i].data}`)
          console.log(`   🖼 ✅ Изображение ${i + 1} сохранено как base64`)
        }
        if (galleryUrls.length > 0) {
          memoryLogger.success(`Gallery сохранена как base64`, { 
            count: galleryUrls.length, 
            messageId, 
            chatId 
          }, 'messageHandler')
        }
      }
    } else if (images.length > 0) {
      // Если нет base64 буферов, пытаемся получить URL через Bot API
      console.log('   🖼 Найдено изображений:', images.length)
      console.log('   🖼 ⚠️ Нет base64 буферов от Worker, пытаюсь получить URL через Bot API...')
      
      // Первое изображение - coverImage
      console.log('   🖼 Получаю URL для первого изображения (file_id:', images[0], ')...')
      const firstImageUrl = await getTelegramFileUrl(images[0])
      if (firstImageUrl) {
        coverImageUrl = firstImageUrl
        console.log('   🖼 ✅ Cover image URL получен:', firstImageUrl.substring(0, 100))
      } else {
        console.log('   🖼 ⚠️ Не удалось получить URL для первого изображения')
      }

      // Остальные - gallery
      for (let i = 1; i < images.length; i++) {
        console.log(`   🖼 Получаю URL для изображения ${i + 1} (file_id: ${images[i]})...`)
        const imageUrl = await getTelegramFileUrl(images[i])
        if (imageUrl) {
          galleryUrls.push(imageUrl)
          console.log(`   🖼 ✅ Изображение ${i + 1} добавлено в gallery`)
        } else {
          console.log(`   🖼 ⚠️ Не удалось получить URL для изображения ${i + 1}`)
        }
      }
    } else {
      console.log('   🖼 Изображений не найдено')
      memoryLogger.warn(`Изображения не найдены в сообщении`, { 
        messageId, 
        chatId,
        hasPhoto: !!message.photo,
        imagesCount: images.length,
        photoBuffersCount: photoBuffers.length
      }, 'messageHandler')
    }

    // 4.6. Группировка фото из одного поста
    // Если сообщение содержит только фото (без текста) и есть существующий draft с таким же chatId,
    // добавляем фото в gallery существующего draft вместо создания нового
    // Ищем draft по времени сообщения (все сообщения из одного поста имеют одинаковое время) ИЛИ по близкому messageId
    if ((!text || text.trim().length === 0) && photoBuffers.length > 0) {
      console.log(`   🔗 Проверяю возможность группировки фото (messageId: ${messageId}, text empty: ${!text || text.trim().length === 0})`)
      const currentMessageIdNum = parseInt(messageId, 10)
      const messageTimestamp = message.date ? (typeof message.date === 'number' ? message.date : Math.floor(new Date(message.date).getTime() / 1000)) : Math.floor(Date.now() / 1000)
      
      // Стратегия 1: Ищем draft с таким же временем сообщения (все сообщения из одного поста имеют одинаковое время)
      const timeWindow = 5 // 5 секунд - сообщения из одного поста имеют одинаковое время
      const searchStart = new Date((messageTimestamp - timeWindow) * 1000)
      const searchEnd = new Date((messageTimestamp + timeWindow) * 1000)
      
      console.log(`   🔗 Ищу draft для группировки: chatId=${chatId}, messageId=${messageId}, время=${messageTimestamp}`)
      console.log(`   🔗 Стратегия 1: По времени сообщения (${searchStart.toISOString()} - ${searchEnd.toISOString()})`)
      
      let existingDraftForGrouping = await prisma.draftEvent.findFirst({
        where: {
          telegramChatId: chatId,
          createdAt: {
            gte: searchStart,
            lte: searchEnd,
          },
          status: {
            in: ['NEW', 'PENDING'],
          },
        },
        orderBy: {
          createdAt: 'desc',
        },
      })
      
      // Стратегия 2: Если не нашли по времени, ищем по messageId (в обе стороны - на случай, если сообщение с текстом придет позже)
      if (!existingDraftForGrouping && !isNaN(currentMessageIdNum)) {
        const minMessageId = Math.max(1, currentMessageIdNum - 10).toString()
        const maxMessageId = (currentMessageIdNum + 10).toString() // Ищем и вперед тоже
        
        console.log(`   🔗 Стратегия 2: По messageId в диапазоне: ${minMessageId} - ${maxMessageId}`)
        
        const possibleDrafts = await prisma.draftEvent.findMany({
          where: {
            telegramChatId: chatId,
            telegramMessageId: {
              gte: minMessageId,
              lte: maxMessageId,
            },
            status: {
              in: ['NEW', 'PENDING'],
            },
          },
          orderBy: {
            telegramMessageId: 'desc',
          },
          take: 1,
        })
        
        existingDraftForGrouping = possibleDrafts.length > 0 ? possibleDrafts[0] : null
      }
      
      if (existingDraftForGrouping) {
        console.log(`   🔗 ✅ Найден существующий draft ${existingDraftForGrouping.id} для группировки фото`)
        console.log(`   🔗 Draft messageId: ${existingDraftForGrouping.telegramMessageId}, текущий messageId: ${messageId}`)
        console.log(`   🖼 Добавляю ${photoBuffers.length} фото в gallery существующего draft`)
        
        // Парсим существующую gallery
        let existingGallery: string[] = []
        if (existingDraftForGrouping.gallery) {
          try {
            existingGallery = JSON.parse(existingDraftForGrouping.gallery)
            console.log(`   🖼 Существующая gallery: ${existingGallery.length} фото`)
          } catch (e) {
            console.warn('   ⚠️ Ошибка парсинга существующей gallery:', e)
          }
        }
        
        // Добавляем новые фото
        for (const photoBuffer of photoBuffers) {
          existingGallery.push(`base64:${photoBuffer.data}`)
        }
        
        // Обновляем draft
        await prisma.draftEvent.update({
          where: { id: existingDraftForGrouping.id },
          data: {
            gallery: JSON.stringify(existingGallery),
          },
        })
        
        console.log(`   ✅ Добавлено ${photoBuffers.length} фото в gallery draft ${existingDraftForGrouping.id}`)
        console.log(`   📊 Всего фото в gallery: ${existingGallery.length}`)
        memoryLogger.success(`Фото добавлены в gallery существующего draft`, { 
          draftId: existingDraftForGrouping.id, 
          addedCount: photoBuffers.length,
          totalCount: existingGallery.length 
        }, 'messageHandler')
        return // Не создаем новый draft, только обновляем существующий
      } else {
        console.log(`   ⚠️ Draft для группировки не найден (сообщение будет пропущено, так как нет текста)`)
        console.log(`   ⚠️ Попробую создать временный draft для последующей группировки...`)
        
        // Если draft не найден, но есть фото - создаем временный draft БЕЗ текста
        // Это нужно на случай, если сообщение с текстом придет позже
        // Но это не сработает, так как для создания draft нужны title и startDate
        // Поэтому просто пропускаем и надеемся, что сообщение с текстом придет раньше
        
        memoryLogger.warn(`Draft для группировки не найден`, { 
          messageId, 
          chatId, 
          messageTimestamp
        }, 'messageHandler')
        return // Пропускаем сообщение без текста, если нет draft для группировки
      }
    }

    // 5. Подготовка данных для карточки одобрения
    // Сохраняем оригинальный текст в description если description не извлечен
    const description = extracted.description || text.substring(0, 1000) || null

    // 5.5. Генерация adminNotes
    console.log('   📝 Шаг 5.5: Генерация adminNotes...')
    console.log(`   📝 Исходный текст для анализа (первые 500 символов): ${text.substring(0, 500)}`)
    const telegramLink = formatTelegramLink(chatId, messageId)
    console.log(`   📝 Telegram ссылка: ${telegramLink}`)
    
    const links = extractLinks(text)
    console.log(`   📝 Найдено ссылок: билеты=${links.tickets.length}, организаторы=${links.organizers.length}`)
    if (links.tickets.length > 0) {
      console.log(`   📝 Ссылки на билеты: ${links.tickets.join(', ')}`)
    } else {
      console.log(`   📝 ⚠️ Ссылки на билеты не найдены в тексте`)
    }
    if (links.organizers.length > 0) {
      console.log(`   📝 Ссылки организаторов: ${links.organizers.join(', ')}`)
    } else {
      console.log(`   📝 ⚠️ Ссылки организаторов не найдены в тексте`)
    }
    
    let coordinates: { lat: number; lng: number } | null = null
    
    // Получаем координаты места, если есть venue и cityName
    console.log(`   📍 Проверка условий для геокодинга:`)
    console.log(`   📍   extracted.venue: ${extracted.venue || 'null'}`)
    console.log(`   📍   extracted.cityName: ${extracted.cityName || 'null'}`)
    console.log(`   📍   channel.city?.name: ${channel.city?.name || 'null'}`)
    console.log(`   📍   YANDEX_MAPS_API_KEY установлен: ${!!process.env.YANDEX_MAPS_API_KEY}`)
    
    if (extracted.venue && (extracted.cityName || channel.city?.name)) {
      const cityName = extracted.cityName || channel.city?.name || ''
      console.log(`   📍 Пытаюсь получить координаты для: "${extracted.venue}", ${cityName}`)
      coordinates = await geocodeVenue(extracted.venue, cityName)
      if (coordinates) {
        console.log(`   📍 ✅ Координаты получены: ${coordinates.lat}, ${coordinates.lng}`)
      } else {
        console.log(`   📍 ⚠️ Координаты не найдены (возможно, нет YANDEX_MAPS_API_KEY или место не найдено)`)
      }
    } else {
      console.log(`   📍 ⚠️ Нет venue или cityName для геокодинга: venue=${extracted.venue || 'null'}, cityName=${extracted.cityName || channel.city?.name || 'null'}`)
    }
    
    // Формируем adminNotes как читаемый текст (не JSON)
    const adminNotesParts: string[] = []
    
    // Добавляем ссылку на пост в Telegram
    adminNotesParts.push(`Источники:`)
    adminNotesParts.push(`1. ${telegramLink}`)
    
    // Добавляем ссылки на билеты
    if (links.tickets.length > 0) {
      links.tickets.forEach((link, index) => {
        adminNotesParts.push(`${index + 2}. ${link}`)
      })
    }
    
    // Добавляем ссылки организаторов
    if (links.organizers.length > 0) {
      if (adminNotesParts.length > 0) {
        adminNotesParts.push('') // Пустая строка для разделения
      }
      adminNotesParts.push(`Ссылки организаторов:`)
      links.organizers.forEach((link, index) => {
        adminNotesParts.push(`${index + 1}. ${link}`)
      })
    }
    
    // Добавляем координаты места
    if (coordinates) {
      if (adminNotesParts.length > 0) {
        adminNotesParts.push('') // Пустая строка для разделения
      }
      adminNotesParts.push(`Координаты места:`)
      adminNotesParts.push(`lat: ${coordinates.lat}, lng: ${coordinates.lng}`)
    }
    
    const adminNotes = adminNotesParts.join('\n')
    console.log('   📝 ✅ AdminNotes сгенерированы (текст):')
    console.log('   📝 ' + adminNotes.split('\n').join('\n   📝 '))
    memoryLogger.info(`AdminNotes сгенерированы`, { 
      telegramLink, 
      ticketLinksCount: links.tickets.length,
      organizerLinksCount: links.organizers.length,
      hasCoordinates: !!coordinates,
      adminNotesLength: adminNotes.length
    }, 'messageHandler')

    // 6. Отправка карточки с кнопками в группу для одобрения ПЕРЕД созданием draft
    console.log(`${getLogPrefix()} 📤 STEP6: SEND_APPROVAL_CARD (BEFORE DRAFT CREATION)`)
    // Используем TELEGRAM_PUBLISH_GROUP_ID для отправки карточек с кнопками
    // Это группа, где находится админ 120352240 для работы с кнопками
    let approvalChatId = process.env.TELEGRAM_PUBLISH_GROUP_ID || process.env.TELEGRAM_ADMIN_CHAT_ID
    if (!approvalChatId) {
      console.error(`${getLogPrefix()} ❌ ERROR: TELEGRAM_PUBLISH_GROUP_ID and TELEGRAM_ADMIN_CHAT_ID not set`)
      return
    }
    
    // Нормализуем chat ID - для групп должен быть минус в начале
    // Если ID начинается с цифры и это группа (длинный ID), добавляем минус
    if (!approvalChatId.startsWith('-') && approvalChatId.length > 9) {
      approvalChatId = `-${approvalChatId}`
      console.log(`${getLogPrefix()}   💡 Исправлен chat ID: добавлен минус -> ${approvalChatId}`)
    }
    
    console.log(`${getLogPrefix()} 📤 Approval Chat ID (group): ${approvalChatId}`)
    console.log(`${getLogPrefix()} 📤 Bot mode: ${settings.mode}`)

    const bot = getBot()

    if (settings.mode === 'AUTO') {
      console.log('   🤖 Автоматический режим, проверяю порог уверенности...')
      console.log('   🤖 Уверенность агента:', agentPrediction.confidence, 'Порог:', settings.confidenceThreshold)
      // Автоматический режим: проверяем порог уверенности
      if (agentPrediction.confidence >= settings.confidenceThreshold) {
        console.log('   🤖 ✅ Высокая уверенность, действую автоматически')
        // Высокая уверенность - создаем draft и действуем автоматически
        const draft = await prisma.draftEvent.create({
          data: {
            cityId: channel.cityId,
            channelId: channel.id,
            telegramMessageId: messageId,
            telegramChatId: chatId,
            sourceLink: formatTelegramLink(chatId, messageId),
            title: extracted.title,
            startDate: parseISOString(extracted.startDateIso),
            endDate: extracted.endDateIso ? parseISOString(extracted.endDateIso) : null,
            venue: extracted.venue || null,
            description: description,
            cityName: extracted.cityName || channel.city?.name || null,
            coverImage: coverImageUrl,
            gallery: galleryUrls.length > 0 ? JSON.stringify(galleryUrls) : null,
            adminNotes: adminNotes,
            status: 'NEW',
          },
        })
        
        if (agentPrediction.decision === 'APPROVED') {
          console.log('   🤖 ✅ Автоматическое одобрение...')
          // Автоматически отправляем в Афишу
          await handleAutoApprove(draft.id, agentPrediction)
        } else {
          console.log('   🤖 ❌ Автоматическое отклонение...')
          // Автоматически отклоняем
          await handleAutoReject(draft.id, agentPrediction)
        }
        return
      }
      console.log('   🤖 ⚠️ Низкая уверенность, отправляю на ручную проверку')
      // Низкая уверенность - отправляем на ручную проверку
    }

    // Ручной режим или низкая уверенность - создаем draft со статусом PENDING и отправляем карточку
    console.log(`${getLogPrefix()} 💾 STEP5: CREATING_DRAFT (PENDING STATUS)`)
    const draft = await prisma.draftEvent.create({
      data: {
        cityId: channel.cityId,
        channelId: channel.id,
        telegramMessageId: messageId,
        telegramChatId: chatId,
        sourceLink: formatTelegramLink(chatId, messageId),
        title: extracted.title,
        startDate: parseISOString(extracted.startDateIso),
        endDate: extracted.endDateIso ? parseISOString(extracted.endDateIso) : null,
        venue: extracted.venue || null,
        description: description,
        cityName: extracted.cityName || channel.city?.name || null,
        coverImage: coverImageUrl,
        gallery: galleryUrls.length > 0 ? JSON.stringify(galleryUrls) : null,
        adminNotes: adminNotes,
        status: 'PENDING', // Статус PENDING - ждем одобрения
      },
    })
    console.log(`${getLogPrefix()} 💾 ✅ DRAFT_CREATED (PENDING): id=${draft.id} title=${draft.title.substring(0, 50)}`)

    // Сохраняем предсказание агента для последующего использования
    const { saveDecision } = await import('@/lib/learning/decisionService')
    await saveDecision({
      telegramMessageId: draft.telegramMessageId,
      telegramChatId: draft.telegramChatId,
      originalText: text,
      extractedFields: extracted,
      userDecision: agentPrediction.decision, // Временно, будет обновлено при callback
      agentPrediction: agentPrediction.decision as any,
      agentConfidence: agentPrediction.confidence,
      agentReasoning: agentPrediction.reasoning,
    })
    console.log('   💾 ✅ Предсказание агента сохранено')

    // Формируем и отправляем карточку с кнопками
    console.log('   📤 Формирую сообщение для одобрения...')
    const messageText = formatDraftMessage(draft, channel, agentPrediction)
    const keyboard = {
      inline_keyboard: [
        [
          { text: '✅ Принять', callback_data: `approve:${draft.id}` },
          { text: '❌ Отказать', callback_data: `reject:${draft.id}` },
        ],
      ],
    }

    console.log(`${getLogPrefix()} 📤 SENDING: approval card to group ${approvalChatId}`)
    memoryLogger.info(
      `STEP6: SEND_APPROVAL_CARD - Отправляю карточку в группу`,
      { approvalChatId, draftId: draft.id },
      'messageHandler'
    )
    
    try {
      await bot.telegram.sendMessage(approvalChatId, messageText, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      })
      console.log(`${getLogPrefix()} 📤 ✅ SENT: approval card sent to group`)
      console.log(`${getLogPrefix()} ✅ SUCCESS: approval card sent, waiting for user decision`)
      memoryLogger.success(
        `Карточка одобрения отправлена в группу`,
        { approvalChatId, draftId: draft.id },
        'messageHandler'
      )
    } catch (error: any) {
      console.error(`${getLogPrefix()} ❌ ERROR sending approval card:`, error.message)
      console.error(`${getLogPrefix()}    Chat ID: ${approvalChatId}`)
      console.error(`${getLogPrefix()}    Error code: ${error.response?.error_code || 'unknown'}`)
      console.error(`${getLogPrefix()}    Error description: ${error.response?.description || error.message}`)
      console.error(`${getLogPrefix()}    💡 Проверьте:`)
      console.error(`${getLogPrefix()}       1. Бот добавлен в группу как администратор?`)
      console.error(`${getLogPrefix()}       2. Правильный ли ID группы? (используйте: npm run group:get-id)`)
      console.error(`${getLogPrefix()}       3. Группа существует и доступна?`)
      
      memoryLogger.error(
        `Ошибка отправки карточки одобрения: ${error.message}`,
        {
          approvalChatId,
          draftId: draft.id,
          errorCode: error.response?.error_code,
          errorDescription: error.response?.description || error.message,
        },
        'messageHandler'
      )
      // Не бросаем ошибку дальше, чтобы не прерывать обработку
    }
      } catch (error) {
        console.error('   ❌ ОШИБКА при обработке сообщения из канала:', error)
        console.error('   ❌ Stack trace:', error instanceof Error ? error.stack : 'нет stack trace')
        console.error('   ❌ Message ID:', messageId)
        console.error('   ❌ Chat ID:', chatId)
      }
}

/**
 * Форматирует сообщение для админа
 */
function formatDraftMessage(
  draft: any,
  channel: any,
  agentPrediction: { decision: string; confidence: number; reasoning: string }
): string {
  const cityName = draft.cityName || channel.city?.name || 'Не указан'
  const venue = draft.venue || 'Не указано'
  const startDate = formatMoscowDate(draft.startDate)
  const endDate = draft.endDate ? formatMoscowDate(draft.endDate) : null
  const description = draft.description || 'Нет описания'

  const agentDecision = agentPrediction.decision === 'APPROVED' ? '✅ Принять' : '❌ Отклонить'
  const confidencePercent = Math.round(agentPrediction.confidence * 100)

  let message = `<b>🎭 Найдено новое мероприятие</b>\n\n`
  message += `<b>Город:</b> ${cityName}\n`
  message += `<b>Канал:</b> ${channel.title}\n`
  message += `<b>Название:</b> ${draft.title}\n`
  message += `<b>Дата начала:</b> ${startDate}\n`
  if (endDate) {
    message += `<b>Дата окончания:</b> ${endDate}\n`
  }
  message += `<b>Место:</b> ${venue}\n`
  message += `<b>Описание:</b> ${description}\n`
  if (draft.sourceLink) {
    message += `\n<a href="${draft.sourceLink}">🔗 Ссылка на пост</a>\n`
  }

  message += `\n<b>🤖 Мнение агента:</b>\n`
  message += `${agentDecision} (уверенность: ${confidencePercent}%)\n`
  message += `<i>${agentPrediction.reasoning}</i>`

  return message
}

/**
 * Автоматическое одобрение (автоматический режим)
 */
export async function handleAutoApprove(
  draftId: number,
  agentPrediction: { decision: string; confidence: number; reasoning: string }
) {
  const draft = await prisma.draftEvent.findUnique({ where: { id: draftId } })
  if (!draft) return

  // Обновляем существующее решение для обучения
  const lastDecision = await prisma.learningDecision.findFirst({
    where: {
      telegramMessageId: draft.telegramMessageId,
      telegramChatId: draft.telegramChatId,
    },
    orderBy: { createdAt: 'desc' },
  })

  if (lastDecision) {
    await prisma.learningDecision.update({
      where: { id: lastDecision.id },
      data: {
        userDecision: 'APPROVED',
      },
    })
  }

  // Отправляем в Афишу (handleApprove уже публикует в группу)
  await handleApprove(draftId)
}

/**
 * Автоматическое отклонение (автоматический режим)
 */
async function handleAutoReject(
  draftId: number,
  agentPrediction: { decision: string; confidence: number; reasoning: string }
) {
  const draft = await prisma.draftEvent.findUnique({ where: { id: draftId } })
  if (!draft) return

  // Обновляем существующее решение для обучения
  const lastDecision = await prisma.learningDecision.findFirst({
    where: {
      telegramMessageId: draft.telegramMessageId,
      telegramChatId: draft.telegramChatId,
    },
    orderBy: { createdAt: 'desc' },
  })

  if (lastDecision) {
    await prisma.learningDecision.update({
      where: { id: lastDecision.id },
      data: {
        userDecision: 'REJECTED',
      },
    })
  }

  // Обновляем статус
  await prisma.draftEvent.update({
    where: { id: draftId },
    data: { status: 'REJECTED' },
  })
}

/**
 * Обработка одобрения (используется и в callback, и в авторежиме)
 */
export async function handleApprove(draftId: number) {
  const draft = await prisma.draftEvent.findUnique({
    where: { id: draftId },
    include: { city: true },
  })

  if (!draft) {
    throw new Error('Draft not found')
  }

  // Парсим gallery из JSON
  let gallery: string[] = []
  if (draft.gallery) {
    try {
      gallery = JSON.parse(draft.gallery)
    } catch (error) {
      console.error('Error parsing gallery JSON:', error)
    }
  }

  // Загружаем изображения в Cloudinary (только для одобренных черновиков)
  console.log(`[handleApprove] Загружаю изображения в Cloudinary для draftId: ${draftId}`)
  memoryLogger.info(`Начинаю загрузку изображений в Cloudinary`, { draftId }, 'callbackHandler')
  
  let cloudinaryCoverImage: string | undefined = undefined
  let cloudinaryGallery: string[] = []
  
  // Проверяем, есть ли изображения в черновике
  console.log(`[handleApprove] Проверка изображений в черновике:`)
  console.log(`[handleApprove]   coverImage: ${draft.coverImage ? (draft.coverImage.startsWith('base64:') ? 'base64 буфер' : 'URL') : 'отсутствует'}`)
  console.log(`[handleApprove]   gallery: ${gallery.length} изображений`)
  memoryLogger.info(`Проверка изображений в черновике`, { 
    hasCoverImage: !!draft.coverImage, 
    coverImageType: draft.coverImage ? (draft.coverImage.startsWith('base64:') ? 'base64' : 'url') : 'none',
    galleryCount: gallery.length 
  }, 'callbackHandler')
  
  try {
    const { uploadImageFromUrl, uploadImageFromBuffer, uploadMultipleImages } = await import('@/lib/cloudinary/upload')
    
    // Загружаем coverImage если есть
    if (draft.coverImage) {
      console.log(`[handleApprove] Загружаю coverImage в Cloudinary...`)
      memoryLogger.info(`Загрузка coverImage в Cloudinary`, { draftId }, 'callbackHandler')
      try {
        // Проверяем, это base64 буфер от Worker или URL
        if (draft.coverImage.startsWith('base64:')) {
          // Это base64 буфер от Worker - загружаем из Buffer
          const base64Data = draft.coverImage.substring(7) // Убираем префикс "base64:"
          const buffer = Buffer.from(base64Data, 'base64')
          console.log(`[handleApprove] Загружаю coverImage из base64 буфера (${buffer.length} bytes)...`)
          const result = await uploadImageFromBuffer(buffer, 'approved')
          cloudinaryCoverImage = result.url
          console.log(`[handleApprove] ✅ CoverImage загружен в Cloudinary из Buffer: ${result.url.substring(0, 100)}...`)
          memoryLogger.success(`CoverImage загружен в Cloudinary`, { draftId, url: result.url.substring(0, 100) }, 'callbackHandler')
        } else {
          // Это URL - загружаем из URL
          const result = await uploadImageFromUrl(draft.coverImage, 'approved')
          cloudinaryCoverImage = result.url
          console.log(`[handleApprove] ✅ CoverImage загружен в Cloudinary из URL: ${result.url.substring(0, 100)}...`)
          memoryLogger.success(`CoverImage загружен в Cloudinary из URL`, { draftId, url: result.url.substring(0, 100) }, 'callbackHandler')
        }
      } catch (error: any) {
        console.error(`[handleApprove] ❌ Ошибка загрузки coverImage в Cloudinary:`, error.message)
        memoryLogger.error(`Ошибка загрузки coverImage в Cloudinary`, { draftId, error: error.message }, 'callbackHandler')
        // Используем оригинальный URL если загрузка не удалась
        cloudinaryCoverImage = draft.coverImage.startsWith('base64:') ? undefined : draft.coverImage
      }
    }
    
    // Загружаем gallery если есть
    if (gallery.length > 0) {
      console.log(`[handleApprove] Загружаю ${gallery.length} изображений gallery в Cloudinary...`)
      
      // Разделяем base64 буферы и URL
      const base64Images: Buffer[] = []
      const urlImages: string[] = []
      
      for (const image of gallery) {
        if (image.startsWith('base64:')) {
          const base64Data = image.substring(7)
          base64Images.push(Buffer.from(base64Data, 'base64'))
        } else {
          urlImages.push(image)
        }
      }
      
      // Загружаем base64 буферы
      for (let i = 0; i < base64Images.length; i++) {
        try {
          console.log(`[handleApprove] Загружаю gallery изображение ${i + 1} из base64 буфера...`)
          const result = await uploadImageFromBuffer(base64Images[i], 'approved')
          cloudinaryGallery.push(result.url)
          console.log(`[handleApprove] ✅ Gallery изображение ${i + 1} загружено в Cloudinary`)
        } catch (error: any) {
          console.error(`[handleApprove] ❌ Ошибка загрузки gallery изображения ${i + 1}:`, error.message)
        }
      }
      
      // Загружаем URL изображения
      if (urlImages.length > 0) {
        try {
          const results = await uploadMultipleImages(urlImages, 'approved')
          cloudinaryGallery.push(...results.map(r => r.url))
          console.log(`[handleApprove] ✅ Загружено ${results.length} URL изображений в Cloudinary`)
        } catch (error: any) {
          console.error(`[handleApprove] ❌ Ошибка загрузки URL изображений:`, error.message)
        }
      }
      
      console.log(`[handleApprove] ✅ Всего загружено ${cloudinaryGallery.length} изображений в Cloudinary`)
      memoryLogger.success(`Gallery загружена в Cloudinary`, { draftId, count: cloudinaryGallery.length }, 'callbackHandler')
    }
  } catch (error: any) {
    console.error(`[handleApprove] ❌ Критическая ошибка при загрузке в Cloudinary:`, error.message)
    memoryLogger.error(`Критическая ошибка при загрузке в Cloudinary`, { draftId, error: error.message }, 'callbackHandler')
    // Используем оригинальные URL если Cloudinary недоступен (но не base64)
    cloudinaryCoverImage = draft.coverImage?.startsWith('base64:') ? undefined : draft.coverImage || undefined
    cloudinaryGallery = gallery.filter(img => !img.startsWith('base64:'))
  }

  // Логируем итоговые данные перед отправкой в Афишу
  console.log(`[handleApprove] Итоговые данные для отправки в Афишу:`)
  console.log(`[handleApprove]   coverImage: ${cloudinaryCoverImage ? cloudinaryCoverImage.substring(0, 100) + '...' : 'отсутствует'}`)
  console.log(`[handleApprove]   gallery: ${cloudinaryGallery.length} изображений`)
  memoryLogger.info(`Отправка в Афишу с изображениями`, { 
    draftId, 
    hasCoverImage: !!cloudinaryCoverImage,
    galleryCount: cloudinaryGallery.length 
  }, 'callbackHandler')

  // Отправляем в Афишу с Cloudinary URL
  const { sendDraft } = await import('@/lib/afisha/client')
  const { toISOString: dateToISO } = await import('@/lib/utils/date')

  // Парсим adminNotes из базы (там хранится как текст, но может быть JSON в старых записях)
  let adminNotesText: string | undefined = undefined
  if (draft.adminNotes) {
    try {
      // Пытаемся распарсить как JSON (для старых записей)
      const parsed = JSON.parse(draft.adminNotes)
      // Если это JSON объект, преобразуем в текст
      if (typeof parsed === 'object' && parsed !== null) {
        const parts: string[] = []
        if (parsed.telegramLink) {
          parts.push(`Источники:`)
          parts.push(`1. ${parsed.telegramLink}`)
        }
        if (parsed.ticketLinks && parsed.ticketLinks.length > 0) {
          parsed.ticketLinks.forEach((link: string, index: number) => {
            parts.push(`${index + 2}. ${link}`)
          })
        }
        if (parsed.organizerLinks && parsed.organizerLinks.length > 0) {
          if (parts.length > 0) parts.push('')
          parts.push(`Ссылки организаторов:`)
          parsed.organizerLinks.forEach((link: string, index: number) => {
            parts.push(`${index + 1}. ${link}`)
          })
        }
        if (parsed.coordinates) {
          if (parts.length > 0) parts.push('')
          parts.push(`Координаты места:`)
          parts.push(`lat: ${parsed.coordinates.lat}, lng: ${parsed.coordinates.lng}`)
        }
        adminNotesText = parts.join('\n')
      } else {
        // Уже текст
        adminNotesText = draft.adminNotes
      }
    } catch (e) {
      // Не JSON, значит уже текст
      adminNotesText = draft.adminNotes
    }
  }

  const response = await sendDraft({
    title: draft.title,
    startDate: dateToISO(draft.startDate),
    endDate: draft.endDate ? dateToISO(draft.endDate) : undefined,
    venue: draft.venue || undefined,
    city: draft.cityName || draft.city?.name || undefined,
    description: draft.description || undefined,
    coverImage: cloudinaryCoverImage,
    gallery: cloudinaryGallery.length > 0 ? cloudinaryGallery : undefined,
    sourceLinks: draft.sourceLink ? [draft.sourceLink] : undefined,
    adminNotes: adminNotesText,
  })

  if (response.isDuplicate) {
    await prisma.draftEvent.update({
      where: { id: draftId },
      data: { status: 'DUPLICATE' },
    })
    return { success: false, isDuplicate: true }
  }

  if (response.success) {
    await prisma.draftEvent.update({
      where: { id: draftId },
      data: { status: 'SENT_TO_AFISHA' },
    })
    
    // Публикуем в группу, если настроена
    await publishToGroup(draft)
    
    return { success: true, eventId: response.eventId }
  }

  throw new Error(response.error || 'Unknown error')
}

/**
 * Публикует обработанное мероприятие в группу
 */
export async function publishToGroup(draft: any) {
  const publishGroupId = process.env.TELEGRAM_PUBLISH_GROUP_ID
  if (!publishGroupId) {
    console.log('   📤 TELEGRAM_PUBLISH_GROUP_ID не настроен, пропускаю публикацию в группу')
    return
  }

  try {
    const bot = getBot()
    
    // Формируем сообщение для публикации
    let messageText = `🎉 <b>${draft.title}</b>\n\n`
    
    if (draft.startDate) {
      const startDate = formatMoscowDate(draft.startDate)
      messageText += `📅 <b>Дата:</b> ${startDate}\n`
    }
    
    if (draft.endDate) {
      const endDate = formatMoscowDate(draft.endDate)
      messageText += `📅 <b>До:</b> ${endDate}\n`
    }
    
    if (draft.venue) {
      messageText += `📍 <b>Место:</b> ${draft.venue}\n`
    }
    
    if (draft.cityName) {
      messageText += `🏙️ <b>Город:</b> ${draft.cityName}\n`
    }
    
    if (draft.description) {
      messageText += `\n${draft.description}\n`
    }
    
    if (draft.sourceLink) {
      messageText += `\n🔗 <a href="${draft.sourceLink}">Источник</a>`
    }

    const options: any = {
      parse_mode: 'HTML',
    }

    // Если есть обложка, отправляем с фото
    if (draft.coverImage) {
      try {
        await bot.telegram.sendPhoto(publishGroupId, draft.coverImage, {
          caption: messageText,
          parse_mode: 'HTML',
        })
        console.log('   📤 ✅ Опубликовано в группу с фото')
        return
      } catch (error) {
        console.error('   ⚠️ Ошибка отправки фото, отправляю только текст:', error)
      }
    }

    // Отправляем только текст
    await bot.telegram.sendMessage(publishGroupId, messageText, options)
    console.log('   📤 ✅ Опубликовано в группу')
  } catch (error) {
    console.error('   ❌ Ошибка публикации в группу:', error)
    // Не прерываем процесс, если публикация не удалась
  }
}

