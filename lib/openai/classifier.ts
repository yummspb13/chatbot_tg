import OpenAI from 'openai'
import { z } from 'zod'

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
})

const ClassificationSchema = z.object({
  category: z.enum(['EVENT', 'GOING_OUT', 'AD']),
  reasoning: z.string().optional(),
})

export type MessageCategory = 'EVENT' | 'GOING_OUT' | 'AD'

/**
 * Классифицирует сообщение из Telegram канала
 * @param text Текст сообщения
 * @returns Категория сообщения
 */
export async function classifyMessage(text: string): Promise<MessageCategory> {
  console.log('      [OpenAI] Классификация: отправляю запрос...')
  console.log('      [OpenAI] Текст (первые 200 символов):', text.substring(0, 200))
  
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini'
  console.log('      [OpenAI] Модель:', model)

  const prompt = `Ты анализируешь сообщения из Telegram каналов о мероприятиях для детей.

Задача: определить категорию сообщения.

Категории:
- EVENT: разовое мероприятие с конкретной датой/временем (спектакль, концерт, мастер-класс, экскурсия и т.д.)
- GOING_OUT: предложение "куда-то сходить" или постоянное место/заведение, которое может быть интересно для афиши (детские площадки, музеи, кафе и т.д.)
- AD: реклама (ЖК, стоматология, кредиты, товары, услуги не связанные с мероприятиями для детей)

Верни только JSON с полем "category" и опциональным полем "reasoning" (краткое объяснение).

Примеры:
- "Детский спектакль 'Золушка' 15 ноября в 18:00" → EVENT
- "Открылась новая детская площадка в парке" → GOING_OUT
- "Купите квартиру в новом ЖК" → AD

Текст сообщения:
${text}

Верни только валидный JSON, без дополнительного текста.`

  try {
    console.log('      [OpenAI] Запрос к API...')
    const response = await openai.chat.completions.create({
      model,
      messages: [
        {
          role: 'system',
          content: 'Ты помощник для классификации сообщений. Всегда возвращай только валидный JSON.',
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
    console.log('      [OpenAI] Содержимое ответа:', content.substring(0, 200))

    const parsed = JSON.parse(content)
    const validated = ClassificationSchema.parse(parsed)
    console.log('      [OpenAI] ✅ Классификация успешна:', validated.category)

    return validated.category
  } catch (error) {
    console.error('      [OpenAI] ❌ Ошибка классификации:', error)
    console.error('      [OpenAI] Stack trace:', error instanceof Error ? error.stack : 'нет stack trace')
    // По умолчанию возвращаем AD, чтобы не обрабатывать непонятные сообщения
    return 'AD'
  }
}

