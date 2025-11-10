import OpenAI from 'openai'
import { z } from 'zod'
import { parseISOString, toISOString } from '@/lib/utils/date'

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
})

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
  console.log('      [OpenAI] Извлечение полей: отправляю запрос...')
  console.log('      [OpenAI] Текст (первые 300 символов):', text.substring(0, 300))
  
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini'
  console.log('      [OpenAI] Модель:', model)

  const currentDate = messageDate ? toISOString(messageDate) : new Date().toISOString()
  console.log('      [OpenAI] Дата сообщения:', currentDate)

  const prompt = `Ты извлекаешь информацию о мероприятии из текста сообщения Telegram.

Задача: извлечь структурированные данные о мероприятии.

Поля:
- title: название мероприятия (обязательно, если есть)
- startDateIso: дата и время начала в формате ISO 8601 UTC (обязательно, если есть)
- endDateIso: дата и время окончания в формате ISO 8601 UTC (опционально)
- venue: место проведения (опционально)
- cityName: название города (опционально, если упоминается)
- description: краткое описание мероприятия (опционально, можно сжать из текста)

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
${text}

Верни только валидный JSON, без дополнительного текста.`

  try {
    console.log('      [OpenAI] Запрос к API для извлечения полей...')
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
    console.log('      [OpenAI] Ответ получен, статус:', response.choices[0]?.finish_reason)
    console.log('      [OpenAI] Использовано токенов:', response.usage?.total_tokens)

    const content = response.choices[0]?.message?.content
    if (!content) {
      console.error('      [OpenAI] ❌ Пустой ответ от OpenAI')
      throw new Error('Empty response from OpenAI')
    }
    console.log('      [OpenAI] Содержимое ответа:', content.substring(0, 500))

    const parsed = JSON.parse(content)
    const validated = ExtractedEventSchema.parse(parsed)
    console.log('      [OpenAI] ✅ Извлечение успешно')
    console.log('      [OpenAI] Извлеченные поля:', JSON.stringify(validated, null, 2))

    // Конвертируем ISO строки в Date объекты для валидации
    if (validated.startDateIso) {
      try {
        parseISOString(validated.startDateIso)
        console.log('      [OpenAI] ✅ startDateIso валидна:', validated.startDateIso)
      } catch (e) {
        console.log('      [OpenAI] ⚠️ startDateIso невалидна, обнуляю:', validated.startDateIso)
        validated.startDateIso = null
      }
    }

    if (validated.endDateIso) {
      try {
        parseISOString(validated.endDateIso)
        console.log('      [OpenAI] ✅ endDateIso валидна:', validated.endDateIso)
      } catch (e) {
        console.log('      [OpenAI] ⚠️ endDateIso невалидна, обнуляю:', validated.endDateIso)
        validated.endDateIso = null
      }
    }

    return validated
  } catch (error) {
    console.error('      [OpenAI] ❌ Ошибка извлечения полей:', error)
    console.error('      [OpenAI] Stack trace:', error instanceof Error ? error.stack : 'нет stack trace')
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

