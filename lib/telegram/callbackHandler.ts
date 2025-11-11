import { Context } from 'telegraf'
import { prisma } from '@/lib/db/prisma'
import { isAdmin, getBot } from './bot'
import { handleApprove } from './messageHandler'
import { saveDecision } from '@/lib/learning/decisionService'

/**
 * Обрабатывает callback_query (нажатия на кнопки)
 */
export async function handleCallback(ctx: Context) {
  console.log('[handleCallback] Начало обработки callback_query')
  console.log('[handleCallback] ctx.callbackQuery exists:', 'callbackQuery' in ctx)
  
  if (!('callbackQuery' in ctx) || !ctx.callbackQuery) {
    console.log('[handleCallback] ❌ callbackQuery отсутствует в ctx')
    return
  }

  const callback = ctx.callbackQuery
  console.log('[handleCallback] callback type:', typeof callback)
  console.log('[handleCallback] callback keys:', callback && typeof callback === 'object' ? Object.keys(callback) : 'not an object')
  
  // Проверяем, что callback - это объект и имеет свойство data
  const data = callback && typeof callback === 'object' && 'data' in callback 
    ? (callback as any).data 
    : null

  console.log('[handleCallback] callback data:', data)

  if (!data) {
    console.log('[handleCallback] ❌ callback data отсутствует')
    return
  }

  console.log('[handleCallback] Проверка админа...')
  // Проверяем, что это админ
  if (!isAdmin(ctx)) {
    console.log('[handleCallback] ❌ Доступ запрещен (не админ)')
    return ctx.answerCbQuery('Доступ запрещен. Только администратор может использовать кнопки.')
  }
  
  console.log('[handleCallback] ✅ Админ подтвержден, обрабатываю callback...')

  try {
    if (data.startsWith('approve:')) {
      const draftId = parseInt(data.split(':')[1], 10)
      await handleApproveCallback(ctx, draftId)
    } else if (data.startsWith('reject:')) {
      const draftId = parseInt(data.split(':')[1], 10)
      await handleRejectCallback(ctx, draftId)
    }
  } catch (error) {
    console.error('Error handling callback:', error)
    await ctx.answerCbQuery('Произошла ошибка. Попробуйте позже.')
  }
}

/**
 * Обработка кнопки "Принять"
 */
async function handleApproveCallback(ctx: Context, draftId: number) {
  console.log(`[handleApproveCallback] Начало обработки для draftId: ${draftId}`)
  
  const draft = await prisma.draftEvent.findUnique({
    where: { id: draftId },
  })

  if (!draft) {
    console.log(`[handleApproveCallback] Черновик ${draftId} не найден`)
    return ctx.answerCbQuery('Черновик не найден.')
  }

  console.log(`[handleApproveCallback] Черновик ${draftId} найден, статус: "${draft.status}" (тип: ${typeof draft.status})`)
  console.log(`[handleApproveCallback] Сравнение: PENDING === "${draft.status}": ${draft.status === 'PENDING'}, NEW === "${draft.status}": ${draft.status === 'NEW'}`)

  // Проверяем статус - может быть PENDING (ожидает одобрения) или NEW (уже одобрен, но не обработан)
  if (draft.status !== 'PENDING' && draft.status !== 'NEW') {
    console.log(`[handleApproveCallback] ❌ Черновик ${draftId} уже обработан (статус: ${draft.status})`)
    return ctx.answerCbQuery('Этот черновик уже обработан.')
  }

  console.log(`[handleApproveCallback] ✅ Черновик ${draftId} может быть обработан, продолжаю...`)

  // Получаем предсказание агента из последнего LearningDecision для этого сообщения
  const lastDecision = await prisma.learningDecision.findFirst({
    where: {
      telegramMessageId: draft.telegramMessageId,
      telegramChatId: draft.telegramChatId,
    },
    orderBy: { createdAt: 'desc' },
  })

  if (!lastDecision) {
    console.warn(`LearningDecision not found for draft ${draftId}, using defaults`)
    // Используем дефолтные значения, если предсказание не найдено
    // Это может произойти, если DraftEvent был создан до добавления логики сохранения предсказаний
  }

  const agentPrediction = lastDecision?.agentPrediction || 'APPROVED'
  const agentConfidence = lastDecision?.agentConfidence || 0.8
  const agentReasoning = lastDecision?.agentReasoning || 'Решение принято пользователем'

  try {
    // Если статус PENDING, меняем на NEW перед обработкой
    if (draft.status === 'PENDING') {
      await prisma.draftEvent.update({
        where: { id: draftId },
        data: { status: 'NEW' },
      })
      console.log(`✅ Draft ${draftId} status changed from PENDING to NEW`)
    }
    
    // Отправляем в Афишу
    const result = await handleApprove(draftId)

    if (result.isDuplicate) {
      await ctx.answerCbQuery('Мероприятие уже существует в Афише.')
      
      // Удаляем сообщение
      if (ctx.callbackQuery && 'message' in ctx.callbackQuery && ctx.callbackQuery.message) {
        const bot = getBot()
        try {
          await bot.telegram.deleteMessage(
            ctx.callbackQuery.message.chat.id,
            ctx.callbackQuery.message.message_id
          )
        } catch (error) {
          console.error('Error deleting message:', error)
        }
      }
      return
    }

    // Обновляем решение для обучения (обновляем userDecision)
    if (lastDecision) {
      await prisma.learningDecision.update({
        where: { id: lastDecision.id },
        data: {
          userDecision: 'APPROVED',
        },
      })
    } else {
      // Если предсказание не было сохранено, создаем новую запись
      const { saveDecision } = await import('@/lib/learning/decisionService')
      await saveDecision({
        telegramMessageId: draft.telegramMessageId,
        telegramChatId: draft.telegramChatId,
        originalText: draft.description || '',
        extractedFields: {
          title: draft.title,
          startDate: draft.startDate,
          endDate: draft.endDate,
          venue: draft.venue,
          cityName: draft.cityName,
        },
        userDecision: 'APPROVED',
        agentPrediction: agentPrediction as any,
        agentConfidence,
        agentReasoning,
      })
    }

    await ctx.answerCbQuery('✅ Черновик создан в Афише!')

    // Публикуем в группу, если настроена
    const { publishToGroup } = await import('./messageHandler')
    await publishToGroup(draft)

    // Удаляем сообщение
    if (ctx.callbackQuery && 'message' in ctx.callbackQuery && ctx.callbackQuery.message) {
      const bot = getBot()
      try {
        await bot.telegram.deleteMessage(
          ctx.callbackQuery.message.chat.id,
          ctx.callbackQuery.message.message_id
        )
      } catch (error) {
        console.error('Error deleting message:', error)
      }
    }
  } catch (error) {
    console.error('Error approving draft:', error)
    await ctx.answerCbQuery('Ошибка при отправке в Афишу. Попробуйте позже.')
  }
}

/**
 * Обработка кнопки "Отказать"
 */
async function handleRejectCallback(ctx: Context, draftId: number) {
  console.log(`[handleRejectCallback] Начало обработки для draftId: ${draftId}`)
  
  const draft = await prisma.draftEvent.findUnique({
    where: { id: draftId },
  })

  if (!draft) {
    console.log(`[handleRejectCallback] Черновик ${draftId} не найден`)
    return ctx.answerCbQuery('Черновик не найден.')
  }

  console.log(`[handleRejectCallback] Черновик ${draftId} найден, статус: "${draft.status}" (тип: ${typeof draft.status})`)
  console.log(`[handleRejectCallback] Сравнение: PENDING === "${draft.status}": ${draft.status === 'PENDING'}, NEW === "${draft.status}": ${draft.status === 'NEW'}`)

  // Проверяем статус - может быть PENDING (ожидает одобрения) или NEW (уже одобрен, но не обработан)
  if (draft.status !== 'PENDING' && draft.status !== 'NEW') {
    console.log(`[handleRejectCallback] ❌ Черновик ${draftId} уже обработан (статус: ${draft.status})`)
    return ctx.answerCbQuery('Этот черновик уже обработан.')
  }

  console.log(`[handleRejectCallback] ✅ Черновик ${draftId} может быть отклонен, продолжаю...`)

  // Обновляем статус на REJECTED
  await prisma.draftEvent.update({
    where: { id: draftId },
    data: { status: 'REJECTED' },
  })

  // Получаем предсказание агента
  const lastDecision = await prisma.learningDecision.findFirst({
    where: {
      telegramMessageId: draft.telegramMessageId,
      telegramChatId: draft.telegramChatId,
    },
    orderBy: { createdAt: 'desc' },
  })

  // Обновляем решение для обучения (обновляем userDecision)
  if (lastDecision) {
    await prisma.learningDecision.update({
      where: { id: lastDecision.id },
      data: {
        userDecision: 'REJECTED',
      },
    })
  } else {
    // Если предсказание не было сохранено, создаем новую запись
    const { saveDecision } = await import('@/lib/learning/decisionService')
    await saveDecision({
      telegramMessageId: draft.telegramMessageId,
      telegramChatId: draft.telegramChatId,
      originalText: draft.description || '',
      extractedFields: {
        title: draft.title,
        startDate: draft.startDate,
        endDate: draft.endDate,
        venue: draft.venue,
        cityName: draft.cityName,
      },
      userDecision: 'REJECTED',
      agentPrediction: 'REJECTED',
      agentConfidence: 0.8,
      agentReasoning: 'Решение принято пользователем',
    })
  }

  await ctx.answerCbQuery('❌ Мероприятие отклонено.')

  // Удаляем сообщение
  if (ctx.callbackQuery && 'message' in ctx.callbackQuery && ctx.callbackQuery.message) {
    const bot = getBot()
    try {
      await bot.telegram.deleteMessage(
        ctx.callbackQuery.message.chat.id,
        ctx.callbackQuery.message.message_id
      )
    } catch (error) {
      console.error('Error deleting message:', error)
    }
  }
}

