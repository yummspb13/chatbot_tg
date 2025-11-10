import { Context } from 'telegraf'
import { prisma } from '@/lib/db/prisma'
import { isAdmin, getBot } from './bot'
import { handleApprove } from './messageHandler'
import { saveDecision } from '@/lib/learning/decisionService'

/**
 * Обрабатывает callback_query (нажатия на кнопки)
 */
export async function handleCallback(ctx: Context) {
  if (!('callback_query' in ctx) || !ctx.callback_query) {
    return
  }

  const callback = ctx.callback_query
  const data = 'data' in callback ? callback.data : null

  if (!data) {
    return
  }

  // Проверяем, что это админ
  if (!isAdmin(ctx)) {
    return ctx.answerCbQuery('Доступ запрещен. Только администратор может использовать кнопки.')
  }

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
  const draft = await prisma.draftEvent.findUnique({
    where: { id: draftId },
  })

  if (!draft) {
    return ctx.answerCbQuery('Черновик не найден.')
  }

  if (draft.status !== 'NEW') {
    return ctx.answerCbQuery('Этот черновик уже обработан.')
  }

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
    // Отправляем в Афишу
    const result = await handleApprove(draftId)

    if (result.isDuplicate) {
      await ctx.answerCbQuery('Мероприятие уже существует в Афише.')
      
      // Удаляем сообщение
      if ('message' in ctx.callback_query && ctx.callback_query.message) {
        const bot = getBot()
        try {
          await bot.telegram.deleteMessage(
            ctx.callback_query.message.chat.id,
            ctx.callback_query.message.message_id
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
    if ('message' in ctx.callback_query && ctx.callback_query.message) {
      const bot = getBot()
      try {
        await bot.telegram.deleteMessage(
          ctx.callback_query.message.chat.id,
          ctx.callback_query.message.message_id
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
  const draft = await prisma.draftEvent.findUnique({
    where: { id: draftId },
  })

  if (!draft) {
    return ctx.answerCbQuery('Черновик не найден.')
  }

  if (draft.status !== 'NEW') {
    return ctx.answerCbQuery('Этот черновик уже обработан.')
  }

  // Обновляем статус
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
  if ('message' in ctx.callback_query && ctx.callback_query.message) {
    const bot = getBot()
    try {
      await bot.telegram.deleteMessage(
        ctx.callback_query.message.chat.id,
        ctx.callback_query.message.message_id
      )
    } catch (error) {
      console.error('Error deleting message:', error)
    }
  }
}

