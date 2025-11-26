/**
 * Обработка вопросов от бота и ответов пользователя
 * Интерактивный режим для уточнения информации о мероприятии
 */

import { Context } from 'telegraf'
import { getBot } from './bot'
import {
  getOrCreateConversation,
  addMessageToConversation,
  getConversationMessages,
  completeConversation,
} from './conversation'
import { getAIClient } from '@/lib/ai/provider'

const aiClient = getAIClient()
const { client: openai, getModel, provider } = aiClient

/**
 * Определяет, нужно ли задать вопрос пользователю
 * @param extracted Извлеченные данные
 * @param originalText Оригинальный текст сообщения
 * @returns Вопрос для пользователя или null
 */
export async function shouldAskQuestion(
  extracted: any,
  originalText: string
): Promise<string | null> {
  // Проверяем, есть ли обязательные поля
  const missingFields: string[] = []
  
  if (!extracted.title) {
    missingFields.push('название мероприятия')
  }
  
  if (!extracted.startDateIso) {
    missingFields.push('дата и время проведения')
  }
  
  // Если отсутствуют критичные поля, задаем вопрос
  if (missingFields.length > 0) {
    return `Не удалось найти ${missingFields.join(' и ')}. Можете уточнить эту информацию?`
  }
  
  // Если есть неопределенность в цене (не указано бесплатно или платно)
  if (extracted.isFree === undefined && !extracted.minPrice) {
    return 'Не удалось определить, бесплатное это мероприятие или платное. Можете уточнить?'
  }
  
  // Если нет адреса, но есть место
  if (extracted.venue && !extracted.venue.includes('ул.') && !extracted.venue.includes('проспект') && !extracted.venue.includes('площадь')) {
    return `Найдено место "${extracted.venue}", но нет полного адреса. Можете указать адрес?`
  }
  
  return null
}

/**
 * Задает вопрос пользователю
 */
export async function askQuestion(
  ctx: Context,
  conversationId: number,
  question: string
): Promise<void> {
  const bot = getBot()
  
  // Сохраняем вопрос в диалог
  await addMessageToConversation(conversationId, 'bot', question)
  
  // Отправляем вопрос пользователю
  await bot.telegram.sendMessage(ctx.chat!.id, question, {
    reply_to_message_id: ctx.message?.message_id,
  })
}

/**
 * Обрабатывает ответ пользователя на вопрос
 */
export async function handleUserAnswer(
  ctx: Context,
  conversationId: number,
  answer: string,
  originalExtracted: any,
  originalText: string
): Promise<any> {
  // Сохраняем ответ в диалог
  await addMessageToConversation(conversationId, 'user', answer)
  
  // Получаем историю диалога
  const messages = await getConversationMessages(conversationId)
  
  // Используем AI для улучшения извлечения на основе ответа
  const improvedExtracted = await improveExtractionWithAnswer(
    originalExtracted,
    originalText,
    answer,
    messages
  )
  
  return improvedExtracted
}

/**
 * Улучшает извлечение на основе ответа пользователя
 */
async function improveExtractionWithAnswer(
  originalExtracted: any,
  originalText: string,
  userAnswer: string,
  conversationHistory: Array<{ role: string; content: string }>
): Promise<any> {
  if (provider === 'mock') {
    // Для mock просто возвращаем оригинальное извлечение
    return originalExtracted
  }
  
  const model = getModel('gpt-4o-mini')
  
  const historyText = conversationHistory
    .map(msg => `${msg.role === 'bot' ? 'Бот' : 'Пользователь'}: ${msg.content}`)
    .join('\n')
  
  const prompt = `Ты улучшаешь извлеченные данные о мероприятии на основе ответа пользователя.

Оригинальный текст сообщения:
${originalText}

Изначально извлеченные данные:
${JSON.stringify(originalExtracted, null, 2)}

История диалога:
${historyText}

Ответ пользователя:
${userAnswer}

Задача: обновить извлеченные данные на основе ответа пользователя.

Верни обновленный JSON с теми же полями, что и в изначально извлеченных данных.
Если пользователь уточнил какую-то информацию, обнови соответствующие поля.
Если информация не изменилась, оставь поле как есть.

Верни только валидный JSON, без дополнительного текста.`

  try {
    const response = await openai.chat.completions.create({
      model,
      messages: [
        {
          role: 'system',
          content: 'Ты помощник для улучшения извлеченных данных о мероприятиях. Всегда возвращай только валидный JSON.',
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
      return originalExtracted
    }
    
    const parsed = JSON.parse(content)
    return { ...originalExtracted, ...parsed }
  } catch (error: any) {
    console.error('[question-handler] Ошибка улучшения извлечения:', error.message)
    return originalExtracted
  }
}

/**
 * Проверяет, является ли сообщение ответом на вопрос бота
 */
export async function isAnswerToQuestion(
  telegramChatId: string,
  telegramMessageId: string
): Promise<boolean> {
  const conversationId = await getOrCreateConversation({
    telegramChatId,
    telegramMessageId,
  })
  
  const messages = await getConversationMessages(conversationId)
  
  // Если последнее сообщение от бота (вопрос), то следующее сообщение - это ответ
  if (messages.length > 0 && messages[messages.length - 1].role === 'bot') {
    return true
  }
  
  return false
}

