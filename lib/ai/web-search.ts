/**
 * Поиск информации в интернете через ChatGPT
 * Использует ChatGPT для поиска информации о мероприятии
 */

import { getAIClient } from '@/lib/ai/provider'

const aiClient = getAIClient()
const { client: openai, getModel, provider } = aiClient

/**
 * Ищет информацию о мероприятии в интернете через ChatGPT
 * @param query Поисковый запрос (название мероприятия, дата, место)
 * @returns Найденная информация о мероприятии
 */
export async function searchEventInfo(query: string): Promise<{
  success: boolean
  information?: string
  error?: string
}> {
  try {
    console.log(`[web-search] Поиск информации: ${query.substring(0, 100)}...`)
    
    // Если mock провайдер - возвращаем пустой результат
    if (provider === 'mock') {
      console.log(`[web-search] Используется MOCK провайдер, пропускаю поиск`)
      return {
        success: true,
        information: '',
      }
    }
    
    const model = getModel('gpt-4o-mini')
    console.log(`[web-search] Модель: ${model}`)
    
    const prompt = `Ты помощник для поиска информации о мероприятиях в интернете.

Задача: найти информацию о мероприятии по запросу пользователя.

Запрос пользователя: ${query}

Найди информацию о мероприятии:
- Название мероприятия
- Дата и время проведения
- Место проведения (адрес)
- Описание мероприятия
- Стоимость билетов (если есть)
- Ссылки на покупку билетов
- Любую другую релевантную информацию

Верни найденную информацию в структурированном виде. Если информации не найдено, верни пустую строку.

ВАЖНО:
- Не выдумывай информацию! Если не нашел - верни пустую строку
- Используй только реальную информацию из интернета
- Если мероприятие не найдено, верни пустую строку`

    console.log(`[web-search] Отправляю запрос к ChatGPT...`)
    
    const response = await openai.chat.completions.create({
      model,
      messages: [
        {
          role: 'system',
          content: 'Ты помощник для поиска информации о мероприятиях. Используй свои знания и возможности поиска для нахождения актуальной информации. Если информации не найдено, верни пустую строку.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      temperature: 0.3,
      max_tokens: 1000,
    })
    
    const information = response.choices[0]?.message?.content || ''
    console.log(`[web-search] Информация получена: ${information.length} символов`)
    console.log(`[web-search] Использовано токенов: ${response.usage?.total_tokens}`)
    
    return {
      success: true,
      information: information.trim(),
    }
  } catch (error: any) {
    console.error(`[web-search] Ошибка поиска:`, error.message)
    return {
      success: false,
      error: error.message || 'Unknown error',
    }
  }
}

/**
 * Ищет информацию о мероприятии на основе названия, даты и места
 * @param title Название мероприятия
 * @param date Дата проведения (опционально)
 * @param venue Место проведения (опционально)
 * @returns Найденная информация
 */
export async function searchEventByDetails(
  title: string,
  date?: string,
  venue?: string
): Promise<{
  success: boolean
  information?: string
  error?: string
}> {
  let query = title
  if (date) {
    query += ` ${date}`
  }
  if (venue) {
    query += ` ${venue}`
  }
  
  return searchEventInfo(query)
}

