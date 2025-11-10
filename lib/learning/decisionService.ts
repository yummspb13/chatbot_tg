import { prisma } from '@/lib/db/prisma'
import { UserDecision } from '@prisma/client'

export type SaveDecisionParams = {
  telegramMessageId: string
  telegramChatId: string
  originalText: string
  extractedFields: Record<string, any>
  userDecision: UserDecision
  agentPrediction: UserDecision
  agentConfidence: number
  agentReasoning?: string
}

/**
 * Сохраняет решение пользователя для обучения агента
 */
export async function saveDecision(params: SaveDecisionParams): Promise<void> {
  await prisma.learningDecision.create({
    data: {
      telegramMessageId: params.telegramMessageId,
      telegramChatId: params.telegramChatId,
      originalText: params.originalText,
      extractedFields: JSON.stringify(params.extractedFields),
      userDecision: params.userDecision,
      agentPrediction: params.agentPrediction,
      agentConfidence: params.agentConfidence,
      agentReasoning: params.agentReasoning,
    },
  })
}

/**
 * Получает статистику обучения
 */
export async function getLearningStats() {
  const total = await prisma.learningDecision.count()
  const approved = await prisma.learningDecision.count({
    where: { userDecision: 'APPROVED' },
  })
  const rejected = await prisma.learningDecision.count({
    where: { userDecision: 'REJECTED' },
  })

  // Точность агента (сколько раз он угадал решение пользователя)
  const correct = await prisma.learningDecision.count({
    where: {
      agentPrediction: {
        equals: prisma.learningDecision.fields.userDecision,
      },
    },
  })

  const accuracy = total > 0 ? (correct / total) * 100 : 0

  return {
    total,
    approved,
    rejected,
    accuracy: Math.round(accuracy * 100) / 100,
  }
}

/**
 * Получает последние решения для анализа
 */
export async function getRecentDecisions(limit: number = 10) {
  return prisma.learningDecision.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
  })
}

