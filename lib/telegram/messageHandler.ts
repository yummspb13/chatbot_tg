import { Context } from 'telegraf'
import { prisma } from '@/lib/db/prisma'
import { getBotSettings } from './bot'
import { classifyMessage } from '@/lib/openai/classifier'
import { extractEvent } from '@/lib/openai/extractor'
import { predictDecision } from '@/lib/openai/agent'
import { formatTelegramLink } from '@/lib/afisha/client'
import { parseISOString, formatMoscowDate } from '@/lib/utils/date'
import { getBot } from './bot'

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
  } catch (error) {
    console.error('         [Telegram] ❌ Ошибка получения URL файла:', error)
    console.error('         [Telegram] Stack trace:', error instanceof Error ? error.stack : 'нет stack trace')
  }
  return null
}

/**
 * Обрабатывает новое сообщение из канала
 */
export async function handleChannelMessage(ctx: Context) {
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

  // Проверяем, что бот запущен
  console.log('   🔍 Проверяю статус бота...')
  const settings = await getBotSettings()
  console.log('   📊 Настройки бота:', {
    isRunning: settings.isRunning,
    mode: settings.mode,
    confidenceThreshold: settings.confidenceThreshold
  })
  
  if (!settings.isRunning) {
    console.log(`   ❌ Бот не запущен (isRunning = false), пропускаю сообщение из канала ${channel.title}`)
    console.log('   💡 Запустите бота командой /start')
    console.log('═══════════════════════════════════════════════════════════')
    console.log('')
    return
  }
  console.log('   ✅ Бот запущен')
  
  console.log(`   📨 Получено сообщение из канала: ${channel.title} (${chatId})`)

  const messageId = message.message_id.toString()
  console.log('   📝 Message ID:', messageId)
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
    console.log('═══════════════════════════════════════════════════════════')
    console.log('')
    return // Уже обработано
  }
  console.log('   ✅ Дубликатов не найдено, продолжаю обработку')

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
    let coverImageUrl: string | null = null
    const galleryUrls: string[] = []

    if (images.length > 0) {
      console.log('   🖼 Найдено изображений:', images.length)
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
    }

    // 5. Создание черновика
    // Сохраняем оригинальный текст в description если description не извлечен
    const description = extracted.description || text.substring(0, 1000) || null

    console.log(`${getLogPrefix()} 💾 STEP5: CREATING_DRAFT`)
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
        status: 'NEW',
      },
    })
    console.log(`${getLogPrefix()} 💾 ✅ DRAFT_CREATED: id=${draft.id} title=${draft.title.substring(0, 50)}`)

    // Сохраняем предсказание агента для последующего использования
    // Сохраняем в LearningDecision с временным статусом (будет обновлен при callback)
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

    // 6. Отправка карточки с кнопками в группу для одобрения
    console.log(`${getLogPrefix()} 📤 STEP7: SEND_APPROVAL_CARD`)
    // Используем TELEGRAM_PUBLISH_GROUP_ID для отправки карточек с кнопками
    // Это группа, где находится админ 120352240 для работы с кнопками
    const approvalChatId = process.env.TELEGRAM_PUBLISH_GROUP_ID || process.env.TELEGRAM_ADMIN_CHAT_ID
    if (!approvalChatId) {
      console.error(`${getLogPrefix()} ❌ ERROR: TELEGRAM_PUBLISH_GROUP_ID and TELEGRAM_ADMIN_CHAT_ID not set`)
      return
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
        // Высокая уверенность - действуем автоматически
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

    // Ручной режим или низкая уверенность - отправляем карточку в группу
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
    await bot.telegram.sendMessage(approvalChatId, messageText, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    })
    console.log(`${getLogPrefix()} 📤 ✅ SENT: approval card sent to group`)
    console.log(`${getLogPrefix()} ✅ SUCCESS: processing completed`)
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

  // Отправляем в Афишу
  const { sendDraft } = await import('@/lib/afisha/client')
  const { toISOString: dateToISO } = await import('@/lib/utils/date')

  const response = await sendDraft({
    title: draft.title,
    startDate: dateToISO(draft.startDate),
    endDate: draft.endDate ? dateToISO(draft.endDate) : undefined,
    venue: draft.venue || undefined,
    city: draft.cityName || draft.city?.name || undefined,
    description: draft.description || undefined,
    coverImage: draft.coverImage || undefined,
    gallery: gallery.length > 0 ? gallery : undefined,
    sourceLinks: draft.sourceLink ? [draft.sourceLink] : undefined,
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

