/**
 * Утилита для создания slug из русского текста
 * Транслитерация русского текста в английские буквы
 */

/**
 * Таблица транслитерации русских букв в латиницу
 */
const transliterationMap: Record<string, string> = {
  'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'yo',
  'ж': 'zh', 'з': 'z', 'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm',
  'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u',
  'ф': 'f', 'х': 'h', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'sch',
  'ъ': '', 'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya',
  'А': 'A', 'Б': 'B', 'В': 'V', 'Г': 'G', 'Д': 'D', 'Е': 'E', 'Ё': 'Yo',
  'Ж': 'Zh', 'З': 'Z', 'И': 'I', 'Й': 'Y', 'К': 'K', 'Л': 'L', 'М': 'M',
  'Н': 'N', 'О': 'O', 'П': 'P', 'Р': 'R', 'С': 'S', 'Т': 'T', 'У': 'U',
  'Ф': 'F', 'Х': 'H', 'Ц': 'Ts', 'Ч': 'Ch', 'Ш': 'Sh', 'Щ': 'Sch',
  'Ъ': '', 'Ы': 'Y', 'Ь': '', 'Э': 'E', 'Ю': 'Yu', 'Я': 'Ya',
}

/**
 * Транслитерирует русский текст в латиницу
 */
function transliterate(text: string): string {
  return text
    .split('')
    .map(char => transliterationMap[char] || char)
    .join('')
}

/**
 * Создает slug из текста
 * @param text Исходный текст (может быть на русском)
 * @returns Slug в формате: lowercase, транслитерированный, с дефисами вместо пробелов, только английские буквы
 */
export function createSlug(text: string): string {
  if (!text) {
    return ''
  }

  // Транслитерируем русский текст
  let slug = transliterate(text)
  
  // Приводим к нижнему регистру
  slug = slug.toLowerCase()
  
  // Удаляем все символы, которые не являются английскими буквами, цифрами, пробелами или дефисами
  // Используем [a-z0-9\s-] для фильтрации только английских букв
  slug = slug.replace(/[^a-z0-9\s-]/g, '')
  
  // Заменяем пробелы на дефисы
  slug = slug.replace(/\s+/g, '-')
  
  // Убираем множественные дефисы
  slug = slug.replace(/-+/g, '-')
  
  // Убираем дефисы в начале и конце
  slug = slug.replace(/^-+|-+$/g, '')
  
  // Ограничиваем длину (максимум 100 символов)
  if (slug.length > 100) {
    slug = slug.substring(0, 100)
    // Убираем дефис в конце, если он остался после обрезки
    slug = slug.replace(/-+$/, '')
  }
  
  return slug
}

/**
 * Создает уникальный slug, добавляя суффикс если нужно
 * @param text Исходный текст
 * @param existingSlugs Массив существующих slug (для проверки уникальности)
 * @returns Уникальный slug
 */
export function createUniqueSlug(text: string, existingSlugs: string[] = []): string {
  let slug = createSlug(text)
  
  // Если slug пустой, используем дефолтное значение
  if (!slug) {
    slug = 'event'
  }
  
  // Проверяем уникальность
  if (!existingSlugs.includes(slug)) {
    return slug
  }
  
  // Если slug уже существует, добавляем суффикс
  let counter = 1
  let uniqueSlug = `${slug}-${counter}`
  
  while (existingSlugs.includes(uniqueSlug)) {
    counter++
    uniqueSlug = `${slug}-${counter}`
    
    // Защита от бесконечного цикла
    if (counter > 1000) {
      uniqueSlug = `${slug}-${Date.now()}`
      break
    }
  }
  
  return uniqueSlug
}

