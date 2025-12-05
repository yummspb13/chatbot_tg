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
  // Приоритет: информация со страницы билетов важнее, чем из поста
  let combinedText = text
  if (parsedLinks.length > 0) {
    // Разделяем ссылки на билеты и организаторов
    const ticketLinks = parsedLinks.filter(link => links.tickets.includes(link.url))
    const organizerLinks = parsedLinks.filter(link => links.organizers.includes(link.url))
    
    // Сначала добавляем информацию со страницы билетов (приоритет)
    if (ticketLinks.length > 0) {
      const ticketLink = ticketLinks[0] // Берем первую ссылку на билеты
      let linkInfo = `\n\n--- ИНФОРМАЦИЯ СО СТРАНИЦЫ БИЛЕТОВ (ПРИОРИТЕТ) ${ticketLink.url} ---\n`
      if (ticketLink.meta.title || ticketLink.meta.ogTitle) {
        linkInfo += `Заголовок с сайта: ${ticketLink.meta.title || ticketLink.meta.ogTitle}\n`
      }
      if (ticketLink.meta.description || ticketLink.meta.ogDescription) {
        linkInfo += `Описание с сайта: ${ticketLink.meta.description || ticketLink.meta.ogDescription}\n`
      }
      linkInfo += `Полный текст со страницы: ${ticketLink.text.substring(0, 3000)}\n`
      combinedText = linkInfo + '\n\n--- ИНФОРМАЦИЯ ИЗ ПОСТА ---\n' + combinedText
    }
    
    // Затем добавляем информацию от организаторов
    if (organizerLinks.length > 0) {
      const linksText = organizerLinks.map(link => {
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
  const { toISOString, getDefaultDate, setDefaultTime, parseISOString, fromMoscowTime, toMoscowTime } = await import('@/lib/utils/date')
  const currentDate = messageDate ? toISOString(messageDate) : new Date().toISOString()
  
  const prompt = `Ты извлекаешь информацию о мероприятии из текста сообщения и дополнительных источников.

Задача: извлечь структурированные данные о мероприятии.

Поля:
- title: название мероприятия (обязательно, если есть). ПРИОРИТЕТ: если есть название на сайте билетов, используй его, но убери фразы типа "со скидкой 20%", "акция" и т.д. Если на сайте название лучше/полнее, используй его вместо названия из поста.
- startDateIso: дата и время начала в формате ISO 8601 UTC (обязательно, если есть)
- endDateIso: дата и время окончания в формате ISO 8601 UTC (опционально)
  * ВАЖНО: Если указана только дата начала без времени окончания (например, "15 декабря в 17:00"), добавь 2 часа к времени начала
- venue: место проведения с ПОЛНЫМ адресом (опционально). ВАЖНО: если на сайте указан полный адрес (например, "пр. Юрия Гагарина, 42"), используй его вместо просто "театр" или названия места. Всегда указывай полный адрес если он есть на сайте.
- cityName: название города (опционально)
- description: развернутое, красивое и детальное описание мероприятия. Переписывай информацию из поста и со страницы сайта своими словами, создавая увлекательный и информативный текст. Включи все важные детали: что это за мероприятие, чем оно интересно, для кого предназначено, что будет происходить. ОБЯЗАТЕЛЬНО включи возрастную категорию (например, "0+", "6+", "для детей от 3 лет" и т.д.) если она указана на сайте или в посте. Используй живой язык, делай описание привлекательным и информативным. Простой текст с переносами строк (не HTML, не Markdown). Структурируй описание логично: вступление, основная часть с деталями, важная информация (возрастные ограничения, особенности посещения и т.д.)
- partnerLink: ссылка на партнера (ссылка на покупку билетов, приоритет - ссылки из раздела "билеты")
- isFree: бесплатное мероприятие (true) или платное (false)
- minPrice: минимальная цена билета в рублях (только если isFree = false). Извлекай только число, например из "от 400 руб" извлеки 400

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
  "title": "Семейная программа 'Где зимует попугай?'",
  "startDateIso": "2025-11-15T15:00:00Z",
  "endDateIso": "2025-11-15T17:00:00Z",
  "venue": "Великокняжеский домик, Александрия, д. 5Д",
  "cityName": "Санкт-Петербург",
  "description": "Самая необычная, яркая и шумная коллекция музея-заповедника «Петергоф» – это птицы. Настоящие птицы – экзотические и лесные. Летом они живут в Вольерах Нижнего парка, а зимой перебираются в «теплые квартиры» Великокняжеского домика в Александрии. Именно здесь, в Великокняжеском домике, где расположен петергофский Птичник, пройдут семейные программы «Где зимует попугай?». Узнаем, как в Петергофе появились попугаи и кто из них самый крупный, самый маленький и самый умный. Познакомимся с длиннохвостым снегирем, полюбуемся важным дубоносом и научимся отличать чечетку от овсянки. Будет весело и громко!\n\nПрограмма подготовлена совместно сотрудниками отдела фауна и детского центра «Новая ферма».\n\nПросьба к посетителям Птичника: не надевать одежду ярких цветов и избегать резких ароматов.\n\nПосещение программы ребенком только в сопровождении взрослого.",
  "partnerLink": "https://afisha.ru/event/123",
  "isFree": false,
  "minPrice": 450
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
    
    // Обработка цены билета - извлекаем только число
    if (validated.minPrice !== null && validated.minPrice !== undefined) {
      // Если minPrice это число, оставляем как есть
      // Если это строка, пытаемся извлечь число
      if (typeof validated.minPrice === 'string') {
        const priceMatch = validated.minPrice.match(/(\d+)/)
        if (priceMatch) {
          validated.minPrice = parseFloat(priceMatch[1])
          console.log('[enhanced-extractor] Цена извлечена из строки:', validated.minPrice)
        } else {
          validated.minPrice = null
          console.log('[enhanced-extractor] Не удалось извлечь число из цены, устанавливаю null')
        }
      } else if (typeof validated.minPrice === 'number') {
        // Уже число, оставляем как есть
        console.log('[enhanced-extractor] Цена уже число:', validated.minPrice)
      }
    }
    
    // Обработка дат по умолчанию
    const { parseISOString, toISOString, getDefaultDate, setDefaultTime, fromMoscowTime, toMoscowTime } = await import('@/lib/utils/date')
    
    // Если дата не найдена, устанавливаем 1990-01-01T00:00:00+03:00 (московское время)
    if (!validated.startDateIso) {
      const defaultDate = getDefaultDate()
      validated.startDateIso = toISOString(defaultDate)
      console.log('[enhanced-extractor] Дата не найдена, установлена по умолчанию: 1990-01-01T00:00:00+03:00')
    } else {
      // Проверяем, есть ли время в дате
      try {
        const startDate = parseISOString(validated.startDateIso)
        const moscowDate = toMoscowTime(startDate)
        
        // Если время 00:00:00 и это не дефолтная дата, возможно время не было указано
        // Но мы не можем точно определить, было ли время указано, поэтому оставляем как есть
        // Если нужно установить время по умолчанию, это будет сделано в messageHandler
        
        // Если endDateIso не указан, но есть startDateIso, добавляем 2 часа
        if (!validated.endDateIso) {
          const endDate = new Date(startDate.getTime() + 2 * 60 * 60 * 1000) // +2 часа
          validated.endDateIso = toISOString(endDate)
          console.log('[enhanced-extractor] Добавлено время окончания: +2 часа к началу')
        }
      } catch (e) {
        console.warn('[enhanced-extractor] Ошибка обработки даты, устанавливаю дефолтную')
        const defaultDate = getDefaultDate()
        validated.startDateIso = toISOString(defaultDate)
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

