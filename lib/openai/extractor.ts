import { z } from 'zod'
import { parseISOString, toISOString } from '@/lib/utils/date'
import { getAIClient } from '@/lib/ai/provider'
import { mockExtractEvent } from '@/lib/ai/mock-provider'

// Используем универсальный провайдер (OpenAI, DeepSeek или Mock)
const aiClient = getAIClient()
const { client: openai, getModel, provider } = aiClient

const ExtractedEventSchema = z.object({
  title: z.string().nullable(),
  startDateIso: z.string().nullable(), // ISO 8601 строка
  endDateIso: z.string().nullable().optional(), // ISO 8601 строка или null
  venue: z.string().nullable().optional(),
  cityName: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
})

export type ExtractedEvent = z.infer<typeof ExtractedEventSchema>

/**
 * Извлекает поля мероприятия из текста сообщения
 * @param text Текст сообщения
 * @param messageDate Дата сообщения (для контекста, если дата не указана явно)
 * @returns Извлеченные поля мероприятия
 */
export async function extractEvent(
  text: string,
  messageDate?: Date
): Promise<ExtractedEvent> {
  console.log('      [AI] Извлечение полей: отправляю запрос...')
  console.log('      [AI] Текст (первые 300 символов):', text.substring(0, 300))
  
  // Если mock провайдер - используем локальную логику
  if (provider === 'mock') {
    console.log('      [AI] Используется MOCK провайдер (локальное тестирование)')
    const extracted = mockExtractEvent(text, messageDate || new Date())
    console.log('      [AI] ✅ MOCK извлечение:', JSON.stringify(extracted, null, 2))
    return extracted
  }
  
  const model = getModel('gpt-4o-mini')
  console.log('      [AI] Модель:', model)

  const currentDate = messageDate ? toISOString(messageDate) : new Date().toISOString()
  console.log('      [AI] Дата сообщения:', currentDate)

  // Получаем примеры из LearningDecision для улучшения промпта
  let examplesText = ''
  try {
    const { prisma } = await import('@/lib/db/prisma')
    const recentDecisions = await prisma.learningDecision.findMany({
      where: {
        userDecision: 'APPROVED',
      },
      orderBy: { createdAt: 'desc' },
      take: 3, // Берем последние 3 одобренных примера
    })
    
    if (recentDecisions.length > 0) {
      examplesText = '\n\nПримеры правильного извлечения:\n'
      for (const decision of recentDecisions) {
        try {
          const extracted = JSON.parse(decision.extractedFields)
          examplesText += `\nПример:\n`
          examplesText += `Текст: ${decision.originalText.substring(0, 200)}...\n`
          examplesText += `Извлечено: ${JSON.stringify(extracted, null, 2)}\n`
        } catch (e) {
          // Игнорируем ошибки парсинга
        }
      }
    }
  } catch (e) {
    // Игнорируем ошибки получения примеров
  }

  // Получаем частые ошибки из обратной связи
  let mistakesText = ''
  try {
    const { getCommonMistakes } = await import('@/lib/learning/feedbackService')
    const mistakes = await getCommonMistakes(3)
    if (mistakes.length > 0) {
      mistakesText = '\n\nЧастые ошибки, которых нужно избегать:\n'
      mistakes.forEach(m => {
        mistakesText += `- ${m.mistake} (встречается ${m.count} раз)\n`
      })
    }
  } catch (e) {
    // Игнорируем ошибки
  }

  const prompt = `Ты извлекаешь информацию о мероприятии из текста сообщения Telegram.

Задача: извлечь структурированные данные о мероприятии.

Поля:
- title: название мероприятия (обязательно, если есть)
- startDateIso: дата и время начала в формате ISO 8601 UTC (обязательно, если есть)
- endDateIso: дата и время окончания в формате ISO 8601 UTC (опционально)
- venue: место проведения (опционально)
- cityName: название города (опционально, если упоминается)
- description: развернутое, красивое и детальное описание мероприятия (опционально). Переписывай текст поста своими словами, создавая увлекательный и информативный текст. Включи все важные детали: что это за мероприятие, чем оно интересно, для кого предназначено, что будет происходить. Используй живой язык, делай описание привлекательным и информативным. Структурируй описание логично: вступление, основная часть с деталями, важная информация (возрастные ограничения, особенности посещения и т.д.). Не сокращай до одного предложения - сохрани все детали из оригинального текста.

ВАЖНО:
- Не выдумывай данные! Если информации нет в тексте, верни null
- Для дат используй московский часовой пояс (Europe/Moscow), но сохраняй в UTC
- Если дата не указана явно, но есть контекст (например, "сегодня", "завтра"), используй текущую дату сообщения: ${currentDate}
- Если дата не указана вообще, верни null для startDateIso

Верни только JSON с полями выше.

Пример ответа:
{
  "title": "Детский спектакль 'Золушка'",
  "startDateIso": "2025-11-15T15:00:00Z",
  "endDateIso": "2025-11-15T17:00:00Z",
  "venue": "Театр кукол им. С.В. Образцова",
  "cityName": "Москва",
  "description": "Волшебная сказка о доброй Золушке"
}

Текст сообщения:
${text}${examplesText}${mistakesText}

Верни только валидный JSON, без дополнительного текста.`

  try {
    console.log('      [AI] Запрос к API для извлечения полей...')
    const response = await openai.chat.completions.create({
      model,
      messages: [
        {
          role: 'system',
          content: 'Ты помощник для извлечения данных о мероприятиях. Всегда возвращай только валидный JSON. Не выдумывай данные, если их нет в тексте.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      temperature: 0.2,
      response_format: { type: 'json_object' },
    })
    console.log('      [AI] Ответ получен, статус:', response.choices[0]?.finish_reason)
    console.log('      [AI] Использовано токенов:', response.usage?.total_tokens)

    const content = response.choices[0]?.message?.content
    if (!content) {
      console.error('      [AI] ❌ Пустой ответ от AI провайдера')
      throw new Error('Empty response from AI provider')
    }
    console.log('      [AI] Содержимое ответа:', content.substring(0, 500))

    const parsed = JSON.parse(content)
    const validated = ExtractedEventSchema.parse(parsed)
    console.log('      [AI] ✅ Извлечение успешно')
    console.log('      [AI] Извлеченные поля:', JSON.stringify(validated, null, 2))

    // Конвертируем ISO строки в Date объекты для валидации
    if (validated.startDateIso) {
      try {
        parseISOString(validated.startDateIso)
        console.log('      [AI] ✅ startDateIso валидна:', validated.startDateIso)
      } catch (e) {
        console.log('      [AI] ⚠️ startDateIso невалидна, обнуляю:', validated.startDateIso)
        validated.startDateIso = null
      }
    }

    if (validated.endDateIso) {
      try {
        parseISOString(validated.endDateIso)
        console.log('      [AI] ✅ endDateIso валидна:', validated.endDateIso)
      } catch (e) {
        console.log('      [AI] ⚠️ endDateIso невалидна, обнуляю:', validated.endDateIso)
        validated.endDateIso = null
      }
    }

    return validated
  } catch (error) {
    console.error('      [AI] ❌ Ошибка извлечения полей:', error)
    console.error('      [AI] Stack trace:', error instanceof Error ? error.stack : 'нет stack trace')
    return {
      title: null,
      startDateIso: null,
      endDateIso: null,
      venue: null,
      cityName: null,
      description: null,
    }
  }
}

