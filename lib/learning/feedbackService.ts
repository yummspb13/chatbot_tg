/**
 * Сервис для обработки обратной связи
 * Сохраняет обратную связь от пользователя для улучшения AI
 */

import { prisma } from '@/lib/db/prisma'

export type FeedbackType = 'redo' | 'question' | 'correction'

export type SaveFeedbackParams = {
  draftEventId: number
  conversationId?: number
  type: FeedbackType
  feedback: string // Текст обратной связи от пользователя
  originalExtracted?: Record<string, any> // Исходные извлеченные данные
  improvedExtracted?: Record<string, any> // Улучшенные данные после обратной связи
}

/**
 * Сохраняет обратную связь от пользователя
 */
export async function saveFeedback(params: SaveFeedbackParams): Promise<void> {
  // Сохраняем обратную связь в LearningDecision или создаем отдельную таблицу
  // Пока используем LearningDecision с дополнительным полем для обратной связи
  
  // Находим последнее решение для этого черновика
  const draft = await prisma.draftEvent.findUnique({
    where: { id: params.draftEventId },
  })
  
  if (!draft) {
    console.warn(`[feedbackService] Draft ${params.draftEventId} not found`)
    return
  }
  
  // Обновляем agentReasoning, добавляя обратную связь
  const lastDecision = await prisma.learningDecision.findFirst({
    where: {
      telegramMessageId: draft.telegramMessageId,
      telegramChatId: draft.telegramChatId,
    },
    orderBy: { createdAt: 'desc' },
  })
  
  if (lastDecision) {
    const feedbackInfo = {
      type: params.type,
      feedback: params.feedback,
      originalExtracted: params.originalExtracted,
      improvedExtracted: params.improvedExtracted,
      timestamp: new Date().toISOString(),
    }
    
    // Добавляем обратную связь в reasoning
    const updatedReasoning = lastDecision.agentReasoning 
      ? `${lastDecision.agentReasoning}\n\n--- Обратная связь ---\n${JSON.stringify(feedbackInfo, null, 2)}`
      : JSON.stringify(feedbackInfo, null, 2)
    
    await prisma.learningDecision.update({
      where: { id: lastDecision.id },
      data: {
        agentReasoning: updatedReasoning,
      },
    })
  } else {
    // Если решения нет, создаем новое с обратной связью
    const { saveDecision } = await import('./decisionService')
    await saveDecision({
      telegramMessageId: draft.telegramMessageId,
      telegramChatId: draft.telegramChatId,
      originalText: draft.description || draft.title,
      extractedFields: params.originalExtracted || {},
      userDecision: 'APPROVED', // Временно, так как это обратная связь, а не решение
      agentPrediction: 'APPROVED',
      agentConfidence: 0.5,
      agentReasoning: JSON.stringify({
        type: params.type,
        feedback: params.feedback,
        originalExtracted: params.originalExtracted,
        improvedExtracted: params.improvedExtracted,
      }, null, 2),
    })
  }
}

/**
 * Получает историю обратной связи для черновика
 */
export async function getFeedbackHistory(draftEventId: number): Promise<Array<{
  type: FeedbackType
  feedback: string
  timestamp: Date
}>> {
  const draft = await prisma.draftEvent.findUnique({
    where: { id: draftEventId },
  })
  
  if (!draft) {
    return []
  }
  
  const decisions = await prisma.learningDecision.findMany({
    where: {
      telegramMessageId: draft.telegramMessageId,
      telegramChatId: draft.telegramChatId,
    },
    orderBy: { createdAt: 'desc' },
  })
  
  const feedbackHistory: Array<{
    type: FeedbackType
    feedback: string
    timestamp: Date
  }> = []
  
  for (const decision of decisions) {
    if (decision.agentReasoning) {
      try {
        // Пытаемся найти обратную связь в reasoning
        const reasoning = decision.agentReasoning
        if (reasoning.includes('--- Обратная связь ---')) {
          const feedbackPart = reasoning.split('--- Обратная связь ---')[1]
          if (feedbackPart) {
            const feedbackData = JSON.parse(feedbackPart.trim())
            feedbackHistory.push({
              type: feedbackData.type || 'redo',
              feedback: feedbackData.feedback || '',
              timestamp: decision.createdAt,
            })
          }
        }
      } catch (e) {
        // Игнорируем ошибки парсинга
      }
    }
  }
  
  return feedbackHistory
}

/**
 * Получает частые ошибки из обратной связи
 */
export async function getCommonMistakes(limit: number = 10): Promise<Array<{
  mistake: string
  count: number
}>> {
  const decisions = await prisma.learningDecision.findMany({
    where: {
      agentReasoning: {
        contains: '--- Обратная связь ---',
      },
    },
    orderBy: { createdAt: 'desc' },
    take: 100, // Берем последние 100 для анализа
  })
  
  const mistakes: Record<string, number> = {}
  
  for (const decision of decisions) {
    if (decision.agentReasoning) {
      try {
        const reasoning = decision.agentReasoning
        if (reasoning.includes('--- Обратная связь ---')) {
          const feedbackPart = reasoning.split('--- Обратная связь ---')[1]
          if (feedbackPart) {
            const feedbackData = JSON.parse(feedbackPart.trim())
            const feedback = feedbackData.feedback?.toLowerCase() || ''
            
            // Извлекаем ключевые слова из обратной связи
            const keywords = [
              'неправильно', 'неверно', 'ошибка', 'не так',
              'не нашел', 'не извлек', 'пропустил', 'не указал',
              'неправильная дата', 'неправильный адрес', 'неправильная цена',
            ]
            
            for (const keyword of keywords) {
              if (feedback.includes(keyword)) {
                mistakes[keyword] = (mistakes[keyword] || 0) + 1
              }
            }
          }
        }
      } catch (e) {
        // Игнорируем ошибки
      }
    }
  }
  
  return Object.entries(mistakes)
    .map(([mistake, count]) => ({ mistake, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
}

