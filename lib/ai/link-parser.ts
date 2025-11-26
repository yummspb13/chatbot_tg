/**
 * Парсинг HTML со страниц по ссылкам
 * Использует простой fetch для получения статического HTML
 */

/**
 * Извлекает текст из HTML (упрощенный парсер)
 */
function extractTextFromHtml(html: string): string {
  // Удаляем скрипты и стили
  let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
  
  // Удаляем HTML теги
  text = text.replace(/<[^>]+>/g, ' ')
  
  // Декодируем HTML entities
  text = text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
  
  // Убираем лишние пробелы и переносы строк
  text = text.replace(/\s+/g, ' ').trim()
  
  return text
}

/**
 * Извлекает мета-теги из HTML
 */
function extractMetaTags(html: string): Record<string, string> {
  const meta: Record<string, string> = {}
  
  // Open Graph и Twitter Card
  const ogTitleMatch = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i)
  if (ogTitleMatch) meta.ogTitle = ogTitleMatch[1]
  
  const ogDescriptionMatch = html.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i)
  if (ogDescriptionMatch) meta.ogDescription = ogDescriptionMatch[1]
  
  // Обычные meta теги
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i)
  if (titleMatch) meta.title = titleMatch[1]
  
  const descriptionMatch = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i)
  if (descriptionMatch) meta.description = descriptionMatch[1]
  
  return meta
}

/**
 * Парсит HTML страницу по ссылке
 * @param url URL страницы для парсинга
 * @returns Объект с текстом и мета-тегами
 */
export async function parseLink(url: string): Promise<{
  url: string
  text: string
  meta: Record<string, string>
  success: boolean
  error?: string
}> {
  try {
    console.log(`[link-parser] Парсинг ссылки: ${url}`)
    
    // Проверяем, что это валидный URL
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return {
        url,
        text: '',
        meta: {},
        success: false,
        error: 'Invalid URL format',
      }
    }
    
    // Получаем HTML
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
      },
      // Таймаут 10 секунд
      signal: AbortSignal.timeout(10000),
    })
    
    if (!response.ok) {
      return {
        url,
        text: '',
        meta: {},
        success: false,
        error: `HTTP ${response.status}: ${response.statusText}`,
      }
    }
    
    const html = await response.text()
    console.log(`[link-parser] HTML получен, размер: ${html.length} символов`)
    
    // Извлекаем текст и мета-теги
    const text = extractTextFromHtml(html)
    const meta = extractMetaTags(html)
    
    console.log(`[link-parser] Текст извлечен: ${text.length} символов`)
    console.log(`[link-parser] Мета-теги: ${Object.keys(meta).length} найдено`)
    
    return {
      url,
      text: text.substring(0, 5000), // Ограничиваем размер текста
      meta,
      success: true,
    }
  } catch (error: any) {
    console.error(`[link-parser] Ошибка парсинга ${url}:`, error.message)
    return {
      url,
      text: '',
      meta: {},
      success: false,
      error: error.message || 'Unknown error',
    }
  }
}

/**
 * Парсит несколько ссылок параллельно
 * @param urls Массив URL для парсинга
 * @returns Массив результатов парсинга
 */
export async function parseLinks(urls: string[]): Promise<Array<{
  url: string
  text: string
  meta: Record<string, string>
  success: boolean
  error?: string
}>> {
  console.log(`[link-parser] Парсинг ${urls.length} ссылок...`)
  
  // Парсим все ссылки параллельно, но с ограничением (максимум 5 одновременно)
  const results = await Promise.allSettled(
    urls.slice(0, 5).map(url => parseLink(url))
  )
  
  return results.map((result, index) => {
    if (result.status === 'fulfilled') {
      return result.value
    } else {
      return {
        url: urls[index],
        text: '',
        meta: {},
        success: false,
        error: result.reason?.message || 'Unknown error',
      }
    }
  })
}

