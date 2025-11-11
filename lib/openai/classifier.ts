import { z } from 'zod'
import { getAIClient } from '@/lib/ai/provider'
import { mockClassifyMessage } from '@/lib/ai/mock-provider'

// Используем универсальный провайдер (OpenAI, DeepSeek или Mock)
const aiClient = getAIClient()
const { client: openai, getModel, provider } = aiClient

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
  console.log('      [AI] Классификация: отправляю запрос...')
  console.log('      [AI] Текст (первые 200 символов):', text.substring(0, 200))
  
  // Если mock провайдер - используем локальную логику
  if (provider === 'mock') {
    console.log('      [AI] Используется MOCK провайдер (локальное тестирование)')
    const category = mockClassifyMessage(text)
    console.log('      [AI] ✅ MOCK классификация:', category)
    return category
  }
  
  const model = getModel('gpt-4o-mini')
  console.log('      [AI] Модель:', model)

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
    console.log('      [AI] Запрос к API...')
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
    console.log('      [AI] Ответ получен, статус:', response.choices[0]?.finish_reason)
    console.log('      [AI] Использовано токенов:', response.usage?.total_tokens)

    const content = response.choices[0]?.message?.content
    if (!content) {
      console.error('      [AI] ❌ Пустой ответ от AI провайдера')
      throw new Error('Empty response from AI provider')
    }
    console.log('      [AI] Содержимое ответа:', content.substring(0, 200))

    const parsed = JSON.parse(content)
    const validated = ClassificationSchema.parse(parsed)
    console.log('      [AI] ✅ Классификация успешна:', validated.category)

    return validated.category
  } catch (error) {
    console.error('      [AI] ❌ Ошибка классификации:', error)
    console.error('      [AI] Stack trace:', error instanceof Error ? error.stack : 'нет stack trace')
    // По умолчанию возвращаем AD, чтобы не обрабатывать непонятные сообщения
    return 'AD'
  }
}

