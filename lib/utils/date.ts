import { format, parseISO } from 'date-fns'
import { toZonedTime, fromZonedTime } from 'date-fns-tz'

const MOSCOW_TZ = 'Europe/Moscow'

/**
 * Конвертирует UTC дату в московское время
 */
export function toMoscowTime(date: Date | string): Date {
  const dateObj = typeof date === 'string' ? parseISO(date) : date
  return toZonedTime(dateObj, MOSCOW_TZ)
}

/**
 * Конвертирует московское время в UTC
 */
export function fromMoscowTime(date: Date): Date {
  return fromZonedTime(date, MOSCOW_TZ)
}

/**
 * Форматирует дату в ISO 8601 строку (UTC)
 */
export function toISOString(date: Date): string {
  return date.toISOString()
}

/**
 * Форматирует дату для отображения в московском времени
 */
export function formatMoscowDate(date: Date | string, formatStr: string = 'dd.MM.yyyy HH:mm'): string {
  const moscowDate = toMoscowTime(date)
  return format(moscowDate, formatStr, { timeZone: MOSCOW_TZ })
}

/**
 * Парсит ISO строку и возвращает Date объект
 */
export function parseISOString(isoString: string): Date {
  return parseISO(isoString)
}

/**
 * Получает текущую дату в московском времени
 */
export function nowMoscow(): Date {
  return toMoscowTime(new Date())
}

