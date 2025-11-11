import { z } from 'zod'
import { prisma } from '@/lib/db/prisma'
import { UserDecision } from '@/lib/learning/decisionService'
import { getAIClient } from '@/lib/ai/provider'
import { mockPredictDecision } from '@/lib/ai/mock-provider'

// Используем универсальный провайдер (OpenAI, DeepSeek или Mock)
const aiClient = getAIClient()
const { client: openai, getModel, provider } = aiClient

const AgentPredictionSchema = z.object({
  decision: z.enum(['APPROVED', 'REJECTED']),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
})

export type AgentPrediction = {
  decision: UserDecision
  confidence: number
  reasoning: string
}

/**
 * Получает историю решений для обучения агента
 */
async function getLearningHistory(limit: number = 50): Promise<string> {
  const decisions = await prisma.learningDecision.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
  })

  if (decisions.length === 0) {
    return 'Истории решений пока нет.'
  }

  const history = decisions
    .map((d) => {
      const extracted = JSON.parse(d.extractedFields || '{}')
      return `Текст: ${d.originalText.substring(0, 200)}...
Извлечено: ${JSON.stringify(extracted)}
Агент предсказал: ${d.agentPrediction} (уверенность: ${d.agentConfidence.toFixed(2)})
Агент объяснил: ${d.agentReasoning || 'нет'}
Пользователь решил: ${d.userDecision}
---`
    })
    .join('\n\n')

  return history
}

/**
 * Предсказывает решение агента на основе текста и извлеченных полей
 * @param originalText Оригинальный текст поста
 * @param extractedFields Извлеченные поля мероприятия
 * @returns Предсказание агента с уверенностью и объяснением
 */
export async function predictDecision(
  originalText: string,
  extractedFields: Record<string, any>
): Promise<AgentPrediction> {
  console.log('      [AI] Предсказание решения: отправляю запрос...')
  console.log('      [AI] Текст (первые 200 символов):', originalText.substring(0, 200))
  console.log('      [AI] Извлеченные поля:', JSON.stringify(extractedFields, null, 2))
  
  // Если mock провайдер - используем локальную логику
  if (provider === 'mock') {
    console.log('      [AI] Используется MOCK провайдер (локальное тестирование)')
    const prediction = mockPredictDecision(originalText, extractedFields)
    console.log('      [AI] ✅ MOCK предсказание:', prediction.decision, 'confidence:', prediction.confidence)
    return {
      decision: prediction.decision as UserDecision,
      confidence: prediction.confidence,
      reasoning: prediction.reasoning,
    }
  }
  
  const model = getModel('gpt-4o-mini')

  // Получаем историю для контекста
  const history = await getLearningHistory(30)

  const prompt = `Ты - агент, который решает, стоит ли добавлять мероприятие в афишу.

Твоя задача: проанализировать мероприятие и решить, одобрить его (APPROVED) или отклонить (REJECTED).

Критерии для APPROVED:
- Мероприятие подходит для детей
- Есть конкретная дата и время
- Есть название мероприятия
- Это не реклама товаров/услуг
- Это не спам

Критерии для REJECTED:
- Нет конкретной даты/времени
- Это реклама (ЖК, стоматология, кредиты и т.д.)
- Не подходит для детской афиши
- Спам или нерелевантный контент

История твоих предыдущих решений и решений пользователя:
${history}

ВАЖНО: Учись на истории! Если пользователь часто отклонял похожие мероприятия, учитывай это.

Новое мероприятие для анализа:
Текст: ${originalText.substring(0, 1000)}
Извлеченные поля: ${JSON.stringify(extractedFields, null, 2)}

Верни JSON с полями:
- decision: "APPROVED" или "REJECTED"
- confidence: число от 0 до 1 (насколько ты уверен в решении)
- reasoning: краткое объяснение твоего решения (2-3 предложения)

Верни только валидный JSON, без дополнительного текста.`

  try {
    console.log('      [AI] Запрос к API для предсказания...')
    const response = await openai.chat.completions.create({
      model,
      messages: [
        {
          role: 'system',
          content: 'Ты агент для принятия решений о мероприятиях. Всегда возвращай только валидный JSON. Учись на истории решений пользователя.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      temperature: 0.3,
      response_format: { type: 'json_object' },
    })
    console.log('      [AI] Ответ получен, статус:', response.choices[0]?.finish_reason)
    console.log('      [AI] Использовано токенов:', response.usage?.total_tokens)

    const content = response.choices[0]?.message?.content
    if (!content) {
      console.error('      [AI] ❌ Пустой ответ от AI провайдера')
      throw new Error('Empty response from AI provider')
    }
    console.log('      [AI] Содержимое ответа:', content.substring(0, 300))

    const parsed = JSON.parse(content)
    const validated = AgentPredictionSchema.parse(parsed)
    console.log('      [AI] ✅ Предсказание успешно:', validated.decision, 'confidence:', validated.confidence)

    return {
      decision: validated.decision as UserDecision,
      confidence: validated.confidence,
      reasoning: validated.reasoning,
    }
  } catch (error) {
    console.error('      [AI] ❌ Ошибка предсказания:', error)
    console.error('      [AI] Stack trace:', error instanceof Error ? error.stack : 'нет stack trace')
    // По умолчанию отклоняем, если не можем предсказать
    return {
      decision: 'REJECTED',
      confidence: 0.5,
      reasoning: 'Ошибка при анализе. Требуется ручная проверка.',
    }
  }
}

