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

  if (!apiKey) {
    throw new Error('BOT_API_KEY is not set')
  }

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
      },
      body: JSON.stringify(draft),
    })

    const data = await response.json()

    if (response.status === 401) {
      return {
        success: false,
        error: 'Unauthorized',
      }
    }

    if (response.status === 400) {
      return {
        success: false,
        error: data.error || 'Bad Request',
      }
    }

    if (!response.ok) {
      return {
        success: false,
        error: data.error || 'Internal server error',
      }
    }

    return data as AfishaDraftResponse
  } catch (error) {
    console.error('Error sending draft to Afisha:', error)
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

