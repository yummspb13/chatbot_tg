/**
 * Mock AI Provider для локального тестирования
 * Возвращает тестовые данные без реальных API вызовов
 */

import { z } from 'zod'

const ClassificationSchema = z.object({
  category: z.enum(['EVENT', 'GOING_OUT', 'AD']),
  reasoning: z.string().optional(),
})

const ExtractedEventSchema = z.object({
  title: z.string().nullable(),
  startDateIso: z.string().nullable(),
  endDateIso: z.string().nullable().optional(),
  venue: z.string().nullable().optional(),
  cityName: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
})

const AgentPredictionSchema = z.object({
  decision: z.enum(['APPROVED', 'REJECTED']),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
})

/**
 * Mock классификация сообщения
 */
export function mockClassifyMessage(text: string): 'EVENT' | 'GOING_OUT' | 'AD' {
  const lowerText = text.toLowerCase()
  
  // Ключевые слова для определения категории
  if (
    lowerText.includes('реклам') ||
    lowerText.includes('кредит') ||
    lowerText.includes('жк') ||
    lowerText.includes('квартир') ||
    lowerText.includes('стоматолог')
  ) {
    return 'AD'
  }
  
  if (
    lowerText.includes('ноябр') ||
    lowerText.includes('декабр') ||
    lowerText.includes('январ') ||
    lowerText.includes('феврал') ||
    lowerText.includes('март') ||
    lowerText.includes('апрел') ||
    lowerText.includes('май') ||
    lowerText.includes('июн') ||
    lowerText.includes('июл') ||
    lowerText.includes('август') ||
    lowerText.includes('сентябр') ||
    lowerText.includes('октябр') ||
    lowerText.includes('концерт') ||
    lowerText.includes('спектакль') ||
    lowerText.includes('мастер-класс') ||
    lowerText.includes('экскурси') ||
    lowerText.includes('выставк') ||
    lowerText.includes('фестивал')
  ) {
    return 'EVENT'
  }
  
  if (
    lowerText.includes('площадк') ||
    lowerText.includes('музей') ||
    lowerText.includes('кафе') ||
    lowerText.includes('парк') ||
    lowerText.includes('открыл')
  ) {
    return 'GOING_OUT'
  }
  
  // По умолчанию - событие, если есть дата
  if (/\d{1,2}\s*(ноябр|декабр|январ|феврал|март|апрел|май|июн|июл|август|сентябр|октябр)/i.test(text)) {
    return 'EVENT'
  }
  
  return 'AD' // По умолчанию реклама, если непонятно
}

/**
 * Mock извлечение данных о мероприятии
 */
export function mockExtractEvent(text: string, messageDate: Date): z.infer<typeof ExtractedEventSchema> {
  // Парсим дату из текста
  const dateMatch = text.match(/(\d{1,2})\s*(ноябр|декабр|январ|феврал|март|апрел|май|июн|июл|август|сентябр|октябр)/i)
  
  let startDate: Date | null = null
  if (dateMatch) {
    const day = parseInt(dateMatch[1])
    const monthName = dateMatch[2].toLowerCase()
    const months: Record<string, number> = {
      'январ': 0, 'феврал': 1, 'март': 2, 'апрел': 3,
      'май': 4, 'июн': 5, 'июл': 6, 'август': 7,
      'сентябр': 8, 'октябр': 9, 'ноябр': 10, 'декабр': 11
    }
    const month = months[monthName] ?? messageDate.getMonth()
    const year = messageDate.getFullYear()
    startDate = new Date(year, month, day, 19, 0, 0) // По умолчанию 19:00
  }
  
  // Парсим время
  const timeMatch = text.match(/(\d{1,2}):(\d{2})/)
  if (timeMatch && startDate) {
    startDate.setHours(parseInt(timeMatch[1]), parseInt(timeMatch[2]), 0, 0)
  }
  
  // Извлекаем название (первая строка или до даты)
  const titleMatch = text.match(/^([^\n]+)/)
  const title = titleMatch ? titleMatch[1].trim() : null
  
  // Извлекаем место
  const venueMatch = text.match(/[Мм]есто[:\s]+([^\n]+)/i) || text.match(/[Вв]\s+([А-ЯЁ][а-яё]+(?:\s+[А-ЯЁ][а-яё]+)*)/)
  const venue = venueMatch ? venueMatch[1].trim() : null
  
  // Извлекаем город
  const cityMatch = text.match(/[Вв]\s+(Москв|Санкт-Петербург|СПб|Питер)/i)
  const cityName = cityMatch ? (cityMatch[1] === 'СПб' || cityMatch[1] === 'Питер' ? 'Санкт-Петербург' : cityMatch[1]) : null
  
  return {
    title: title || 'Тестовое мероприятие',
    startDateIso: startDate ? startDate.toISOString() : null,
    endDateIso: startDate ? new Date(startDate.getTime() + 2 * 60 * 60 * 1000).toISOString() : null, // +2 часа
    venue: venue,
    cityName: cityName,
    description: text.substring(0, 500),
  }
}

/**
 * Mock предсказание решения
 */
export function mockPredictDecision(
  originalText: string,
  extractedFields: Record<string, any>
): z.infer<typeof AgentPredictionSchema> {
  // Простая логика: если есть название и дата - одобряем
  const hasTitle = extractedFields.title && extractedFields.title !== 'Тестовое мероприятие'
  const hasDate = extractedFields.startDateIso
  
  if (hasTitle && hasDate) {
    return {
      decision: 'APPROVED',
      confidence: 0.85,
      reasoning: 'Мероприятие содержит все необходимые данные: название и дату. Подходит для публикации.',
    }
  }
  
  return {
    decision: 'REJECTED',
    confidence: 0.7,
    reasoning: 'Недостаточно данных для публикации. Требуется ручная проверка.',
  }
}

