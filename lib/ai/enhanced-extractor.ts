/**
 * Улучшенный экстрактор с поддержкой парсинга ссылок и поиска в интернете
 */

import { extractEvent, ExtractedEvent } from '@/lib/openai/extractor'
import { parseLinks } from './link-parser'
import { searchEventByDetails, searchEventInfo } from './web-search'
import { extractLinks } from '@/lib/utils/link-extractor'
import { z } from 'zod'

// Расширенная схема с новыми полями
export const EnhancedExtractedEventSchema = z.object({
  title: z.string().nullable(),
  startDateIso: z.string().nullable(),
  endDateIso: z.string().nullable().optional(),
  venue: z.string().nullable().optional(),
  cityName: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  partnerLink: z.string().nullable().optional(), // ссылка на партнера
  isFree: z.boolean().optional(), // бесплатное мероприятие
  minPrice: z.number().nullable().optional(), // минимальная цена билета
})

export type EnhancedExtractedEvent = z.infer<typeof EnhancedExtractedEventSchema>

/**
 * Улучшенное извлечение события с парсингом ссылок и поиском в интернете
 * @param text Текст сообщения
 * @param messageDate Дата сообщения
 * @returns Расширенные извлеченные поля
 */
export async function extractEventEnhanced(
  text: string,
  messageDate?: Date
): Promise<EnhancedExtractedEvent> {
  console.log('[enhanced-extractor] Начинаю улучшенное извлечение...')
  
  // 1. Базовое извлечение из текста
  console.log('[enhanced-extractor] Шаг 1: Базовое извлечение из текста...')
  const baseExtracted = await extractEvent(text, messageDate)
  
  // 2. Извлекаем ссылки из текста
  console.log('[enhanced-extractor] Шаг 2: Извлечение ссылок...')
  const links = extractLinks(text)
  console.log(`[enhanced-extractor] Найдено ссылок: билеты=${links.tickets.length}, организаторы=${links.organizers.length}`)
  
  // 3. Парсим ссылки (билеты и организаторы)
  const allUrls = [...links.tickets, ...links.organizers]
  let parsedLinks: Array<{ url: string; text: string; meta: Record<string, string> }> = []
  
  if (allUrls.length > 0) {
    console.log('[enhanced-extractor] Шаг 3: Парсинг ссылок...')
    const parsed = await parseLinks(allUrls)
    parsedLinks = parsed.filter(p => p.success).map(p => ({
      url: p.url,
      text: p.text,
      meta: p.meta,
    }))
    console.log(`[enhanced-extractor] Успешно распарсено ссылок: ${parsedLinks.length}`)
  }
  
  // 4. Объединяем текст из сообщения и распарсенных ссылок
  let combinedText = text
  if (parsedLinks.length > 0) {
    const linksText = parsedLinks.map(link => {
      let linkInfo = `\n\n--- Информация со страницы ${link.url} ---\n`
      if (link.meta.title || link.meta.ogTitle) {
        linkInfo += `Заголовок: ${link.meta.title || link.meta.ogTitle}\n`
      }
      if (link.meta.description || link.meta.ogDescription) {
        linkInfo += `Описание: ${link.meta.description || link.meta.ogDescription}\n`
      }
      linkInfo += `Текст: ${link.text.substring(0, 2000)}\n`
      return linkInfo
    }).join('\n')
    combinedText += linksText
  }
  
  // 5. Поиск информации в интернете через ChatGPT
  let webSearchInfo = ''
  if (baseExtracted.title) {
    console.log('[enhanced-extractor] Шаг 4: Поиск информации в интернете...')
    const searchResult = await searchEventByDetails(
      baseExtracted.title,
      baseExtracted.startDateIso || undefined,
      baseExtracted.venue || undefined
    )
    if (searchResult.success && searchResult.information) {
      webSearchInfo = searchResult.information
      console.log(`[enhanced-extractor] Найдена информация в интернете: ${webSearchInfo.length} символов`)
      combinedText += `\n\n--- Информация из интернета ---\n${webSearchInfo}\n`
    }
  }
  
  // 6. Улучшенное извлечение с учетом всей собранной информации
  console.log('[enhanced-extractor] Шаг 5: Улучшенное извлечение с учетом всех источников...')
  const enhancedExtracted = await extractEventEnhancedFromCombinedText(
    combinedText,
    baseExtracted,
    links,
    messageDate
  )
  
  console.log('[enhanced-extractor] ✅ Извлечение завершено')
  return enhancedExtracted
}

/**
 * Извлекает расширенные поля из объединенного текста
 */
async function extractEventEnhancedFromCombinedText(
  combinedText: string,
  baseExtracted: ExtractedEvent,
  links: { tickets: string[]; organizers: string[] },
  messageDate?: Date
): Promise<EnhancedExtractedEvent> {
  const { getAIClient } = await import('@/lib/ai/provider')
  const aiClient = getAIClient()
  const { client: openai, getModel, provider } = aiClient
  
  // Если mock провайдер - возвращаем базовое извлечение
  if (provider === 'mock') {
    return {
      ...baseExtracted,
      partnerLink: links.tickets[0] || null,
      isFree: false,
      minPrice: null,
    }
  }
  
  const model = getModel('gpt-4o-mini')
  const { toISOString } = await import('@/lib/utils/date')
  const currentDate = messageDate ? toISOString(messageDate) : new Date().toISOString()
  
  const prompt = `Ты извлекаешь информацию о мероприятии из текста сообщения и дополнительных источников.

Задача: извлечь структурированные данные о мероприятии.

Поля:
- title: название мероприятия (обязательно, если есть)
- startDateIso: дата и время начала в формате ISO 8601 UTC (обязательно, если есть)
- endDateIso: дата и время окончания в формате ISO 8601 UTC (опционально)
  * ВАЖНО: Если указана только дата начала без времени окончания (например, "15 декабря в 17:00"), добавь 2 часа к времени начала
- venue: место проведения с адресом (опционально)
- cityName: название города (опционально)
- description: развернутое описание мероприятия, переписанное уникально, сохраняя всю важную информацию
- partnerLink: ссылка на партнера (ссылка на покупку билетов, приоритет - ссылки из раздела "билеты")
- isFree: бесплатное мероприятие (true) или платное (false)
- minPrice: минимальная цена билета в рублях (только если isFree = false)

ВАЖНО:
- Не выдумывай данные! Если информации нет, верни null
- Для дат используй московский часовой пояс (Europe/Moscow), но сохраняй в UTC
- Если дата не указана явно, но есть контекст, используй: ${currentDate}
- Если дата указана без времени окончания, добавь 2 часа к времени начала
- Если isFree = true, minPrice должен быть null
- Если isFree = false и цена не указана, minPrice = null (не выдумывай цену)

Верни только JSON с полями выше.

Пример ответа:
{
  "title": "Детский спектакль 'Золушка'",
  "startDateIso": "2025-11-15T15:00:00Z",
  "endDateIso": "2025-11-15T17:00:00Z",
  "venue": "Театр кукол им. С.В. Образцова, ул. Садовая-Самотечная, 3",
  "cityName": "Москва",
  "description": "Волшебная сказка о доброй Золушке...",
  "partnerLink": "https://afisha.ru/event/123",
  "isFree": false,
  "minPrice": 300
}

Объединенный текст из всех источников:
${combinedText.substring(0, 8000)}

Верни только валидный JSON, без дополнительного текста.`

  try {
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
    
    const content = response.choices[0]?.message?.content
    if (!content) {
      console.error('[enhanced-extractor] ❌ Пустой ответ от AI')
      return {
        ...baseExtracted,
        partnerLink: links.tickets[0] || null,
        isFree: false,
        minPrice: null,
      }
    }
    
    const parsed = JSON.parse(content)
    const validated = EnhancedExtractedEventSchema.parse(parsed)
    
    // Если endDateIso не указан, но есть startDateIso, добавляем 2 часа
    if (validated.startDateIso && !validated.endDateIso) {
      const { parseISOString, toISOString } = await import('@/lib/utils/date')
      try {
        const startDate = parseISOString(validated.startDateIso)
        const endDate = new Date(startDate.getTime() + 2 * 60 * 60 * 1000) // +2 часа
        validated.endDateIso = toISOString(endDate)
        console.log('[enhanced-extractor] Добавлено время окончания: +2 часа к началу')
      } catch (e) {
        console.warn('[enhanced-extractor] Не удалось добавить время окончания')
      }
    }
    
    return validated
  } catch (error: any) {
    console.error('[enhanced-extractor] ❌ Ошибка извлечения:', error.message)
    // Возвращаем базовое извлечение с добавлением ссылок
    return {
      ...baseExtracted,
      partnerLink: links.tickets[0] || null,
      isFree: false,
      minPrice: null,
    }
  }
}

