import { parseISO } from 'date-fns'
import { toZonedTime, fromZonedTime, formatInTimeZone } from 'date-fns-tz'

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
  const dateObj = typeof date === 'string' ? parseISO(date) : date
  return formatInTimeZone(dateObj, MOSCOW_TZ, formatStr)
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

/**
 * Создает дату по умолчанию: 1990-01-01T00:00:00+03:00 (московское время)
 * @returns Date объект в UTC (для хранения в БД)
 */
export function getDefaultDate(): Date {
  // Создаем дату 1990-01-01 00:00:00 в московском времени
  // 1990-01-01 00:00:00 MSK (UTC+3) = 1989-12-31 21:00:00 UTC
  // Но нужно учесть, что в 1990 году был UTC+3, но сейчас может быть UTC+2 или UTC+3
  // Используем фиксированный offset +03:00 для 1990 года
  return new Date('1989-12-31T21:00:00Z')
}

/**
 * Создает время по умолчанию: 00:00:00+03:00 (московское время) для указанной даты
 * @param date Дата, для которой нужно установить время 00:00:00
 * @returns Date объект с временем 00:00:00 в московском времени (конвертированный в UTC)
 */
export function setDefaultTime(date: Date): Date {
  // Получаем дату в московском времени
  const moscowDate = toMoscowTime(date)
  // Устанавливаем время на 00:00:00
  moscowDate.setHours(0, 0, 0, 0)
  // Конвертируем обратно в UTC для хранения
  return fromMoscowTime(moscowDate)
}

/**
 * Конвертирует ISO строку с московским временем в UTC Date
 * @param isoString ISO строка в формате "1990-01-01T00:00:00+03:00"
 * @returns Date объект в UTC
 */
export function parseMoscowISO(isoString: string): Date {
  // Парсим ISO строку с timezone offset
  return parseISO(isoString)
}

