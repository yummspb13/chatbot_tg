import { prisma } from '@/lib/db/prisma'

/**
 * Экспортирует данные для fine-tuning в формате OpenAI
 * Формат: JSONL с промптами и ответами
 */
export async function exportTrainingData(): Promise<string> {
  const decisions = await prisma.learningDecision.findMany({
    orderBy: { createdAt: 'asc' },
  })

  const trainingData: string[] = []

  for (const decision of decisions) {
    const extracted = JSON.parse(decision.extractedFields || '{}')
    
    const prompt = `Ты - агент, который решает, стоит ли добавлять мероприятие в афишу.

Текст: ${decision.originalText.substring(0, 1000)}
Извлеченные поля: ${JSON.stringify(extracted, null, 2)}

Верни JSON с полями:
- decision: "APPROVED" или "REJECTED"
- confidence: число от 0 до 1
- reasoning: краткое объяснение`

    const completion = JSON.stringify({
      decision: decision.userDecision,
      confidence: decision.agentConfidence,
      reasoning: decision.agentReasoning || '',
    })

    const trainingExample = {
      messages: [
        {
          role: 'system',
          content: 'Ты агент для принятия решений о мероприятиях. Всегда возвращай только валидный JSON.',
        },
        {
          role: 'user',
          content: prompt,
        },
        {
          role: 'assistant',
          content: completion,
        },
      ],
    }

    trainingData.push(JSON.stringify(trainingExample))
  }

  return trainingData.join('\n')
}

/**
 * Сохраняет данные для fine-tuning в файл
 */
export async function saveTrainingDataToFile(filePath: string): Promise<void> {
  const data = await exportTrainingData()
  const fs = await import('fs/promises')
  await fs.writeFile(filePath, data, 'utf-8')
}

