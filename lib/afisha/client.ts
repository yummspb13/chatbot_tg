import { toISOString } from '@/lib/utils/date'

export type AfishaDraftRequest = {
  title: string
  startDate: string // ISO 8601
  endDate?: string // ISO 8601
  venue?: string
  city?: string
  description?: string
  coverImage?: string
  gallery?: string[]
  sourceLinks?: string[]
}

export type AfishaDraftResponse = {
  success: boolean
  eventId?: string
  isDuplicate?: boolean
  error?: string
}

/**
 * Отправляет черновик мероприятия в API Афиши
 * @param draft Данные черновика
 * @returns Ответ от API
 */
export async function sendDraft(draft: AfishaDraftRequest): Promise<AfishaDraftResponse> {
  const apiUrl = process.env.AFISHA_DRAFT_URL || 'https://kiddeo.vercel.app/api/bot/events/draft'
  const apiKey = process.env.BOT_API_KEY

  console.log(`[sendDraft] Отправка черновика в Афишу: ${draft.title}`)
  console.log(`[sendDraft] API URL: ${apiUrl}`)
  console.log(`[sendDraft] BOT_API_KEY установлен: ${!!apiKey}`)

  if (!apiKey) {
    const error = 'BOT_API_KEY is not set'
    console.error(`[sendDraft] ❌ ${error}`)
    throw new Error(error)
  }

  try {
    console.log(`[sendDraft] Отправляю POST запрос на ${apiUrl}...`)
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
      },
      body: JSON.stringify(draft),
    })

    console.log(`[sendDraft] Response status: ${response.status} ${response.statusText}`)
    console.log(`[sendDraft] Response Content-Type: ${response.headers.get('content-type')}`)
    
    // Проверяем, что ответ - это JSON, а не HTML
    const contentType = response.headers.get('content-type') || ''
    const responseText = await response.text()
    
    if (!contentType.includes('application/json')) {
      console.error(`[sendDraft] ❌ API вернул не JSON, а ${contentType}`)
      console.error(`[sendDraft] Response preview:`, responseText.substring(0, 500))
      
      // Если это HTML (вероятно 404 или ошибка), возвращаем понятную ошибку
      if (responseText.trim().startsWith('<!DOCTYPE') || responseText.trim().startsWith('<html')) {
        return {
          success: false,
          error: `API вернул HTML вместо JSON. Возможно, URL неправильный или endpoint не существует. Status: ${response.status}`,
        }
      }
      
      return {
        success: false,
        error: `API вернул не JSON (${contentType}). Status: ${response.status}`,
      }
    }
    
    let data
    try {
      data = JSON.parse(responseText)
      console.log(`[sendDraft] Response data:`, JSON.stringify(data, null, 2))
    } catch (parseError: any) {
      console.error(`[sendDraft] ❌ Ошибка парсинга JSON:`, parseError.message)
      console.error(`[sendDraft] Response text:`, responseText.substring(0, 1000))
      return {
        success: false,
        error: `Ошибка парсинга ответа от API: ${parseError.message}`,
      }
    }

    if (response.status === 401) {
      console.error(`[sendDraft] ❌ Unauthorized - проверьте BOT_API_KEY`)
      return {
        success: false,
        error: 'Unauthorized - проверьте BOT_API_KEY',
      }
    }

    if (response.status === 400) {
      console.error(`[sendDraft] ❌ Bad Request:`, data.error || 'Bad Request')
      return {
        success: false,
        error: data.error || 'Bad Request',
      }
    }

    if (!response.ok) {
      console.error(`[sendDraft] ❌ Error ${response.status}:`, data.error || 'Internal server error')
      return {
        success: false,
        error: data.error || 'Internal server error',
      }
    }

    console.log(`[sendDraft] ✅ Успешно отправлено в Афишу, eventId: ${data.eventId}`)
    return data as AfishaDraftResponse
  } catch (error: any) {
    console.error(`[sendDraft] ❌ Ошибка отправки в Афишу:`, error)
    console.error(`[sendDraft] Stack:`, error.stack)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }
  }
}

/**
 * Формирует ссылку на Telegram пост
 * @param chatId ID чата/канала
 * @param messageId ID сообщения
 * @returns Ссылка на пост
 */
export function formatTelegramLink(chatId: string, messageId: string): string {
  // Если chatId начинается с -100, это супергруппа/канал
  // Формат ссылки: https://t.me/c/{chatId}/{messageId}
  // Но нужно убрать -100 из начала
  const cleanChatId = chatId.replace(/^-100/, '')
  return `https://t.me/c/${cleanChatId}/${messageId}`
}

