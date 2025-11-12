/**
 * Извлекает ссылки из текста поста и классифицирует их
 */

export interface ExtractedLinks {
  tickets: string[]
  organizers: string[]
}

/**
 * Извлекает все URL из текста
 */
function extractUrls(text: string): string[] {
  const urlRegex = /(https?:\/\/[^\s]+)/gi
  const matches = text.match(urlRegex)
  return matches ? [...new Set(matches)] : [] // Убираем дубликаты
}

/**
 * Классифицирует ссылку как билетную или организатора
 */
function classifyLink(url: string, context: string): 'ticket' | 'organizer' | 'other' {
  const lowerUrl = url.toLowerCase()
  const lowerContext = context.toLowerCase()

  // Ключевые слова для билетов
  const ticketKeywords = [
    'билет',
    'ticket',
    'купить',
    'buy',
    'заказать',
    'order',
    'afisha',
    'афиша',
    'kassir',
    'кассир',
    'ticketland',
    'bileter',
    'билетер',
  ]

  // Ключевые слова для организаторов
  const organizerKeywords = [
    'сайт',
    'website',
    'официальный',
    'official',
    'vk.com',
    'instagram.com',
    'facebook.com',
    'telegram',
    't.me',
    'youtube.com',
    'соц',
    'социальн',
  ]

  // Проверяем контекст вокруг ссылки (50 символов до и после)
  const urlIndex = context.toLowerCase().indexOf(url.toLowerCase())
  if (urlIndex !== -1) {
    const start = Math.max(0, urlIndex - 50)
    const end = Math.min(context.length, urlIndex + url.length + 50)
    const surroundingText = context.substring(start, end).toLowerCase()

    // Проверяем билетные ключевые слова
    for (const keyword of ticketKeywords) {
      if (lowerUrl.includes(keyword) || surroundingText.includes(keyword)) {
        return 'ticket'
      }
    }

    // Проверяем ключевые слова организатора
    for (const keyword of organizerKeywords) {
      if (lowerUrl.includes(keyword) || surroundingText.includes(keyword)) {
        return 'organizer'
      }
    }
  }

  // Если URL содержит домены соцсетей - это организатор
  if (
    lowerUrl.includes('vk.com') ||
    lowerUrl.includes('instagram.com') ||
    lowerUrl.includes('facebook.com') ||
    lowerUrl.includes('youtube.com') ||
    lowerUrl.includes('t.me')
  ) {
    return 'organizer'
  }

  return 'other'
}

/**
 * Извлекает и классифицирует ссылки из текста поста
 * @param text Текст поста
 * @returns Объект с массивами ссылок на билеты и организаторов
 */
export function extractLinks(text: string): ExtractedLinks {
  const urls = extractUrls(text)
  const result: ExtractedLinks = {
    tickets: [],
    organizers: [],
  }

  for (const url of urls) {
    const classification = classifyLink(url, text)
    if (classification === 'ticket') {
      result.tickets.push(url)
    } else if (classification === 'organizer') {
      result.organizers.push(url)
    }
  }

  return result
}

