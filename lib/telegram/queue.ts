/**
 * Система очереди для обработки сообщений от админа
 * Обеспечивает последовательную обработку сообщений
 */

interface ProcessingStatus {
  isProcessing: boolean
  chatId: string
  messageId: string
  startTime: number
}

// Хранилище статусов обработки (в памяти)
// Ключ: chatId, значение: статус обработки
const processingQueue = new Map<string, ProcessingStatus>()

// Очередь ожидающих сообщений
// Ключ: chatId, значение: массив messageId
const waitingQueue = new Map<string, string[]>()

/**
 * Проверяет, обрабатывается ли сейчас сообщение для данного чата
 */
export function isProcessing(chatId: string): boolean {
  const status = processingQueue.get(chatId)
  return status?.isProcessing || false
}

/**
 * Начинает обработку сообщения
 */
export function startProcessing(chatId: string, messageId: string): void {
  processingQueue.set(chatId, {
    isProcessing: true,
    chatId,
    messageId,
    startTime: Date.now(),
  })
  console.log(`[queue] Начата обработка: chatId=${chatId}, messageId=${messageId}`)
}

/**
 * Завершает обработку сообщения
 */
export function finishProcessing(chatId: string): void {
  const status = processingQueue.get(chatId)
  if (status) {
    const duration = Date.now() - status.startTime
    console.log(`[queue] Завершена обработка: chatId=${chatId}, messageId=${status.messageId}, длительность=${duration}ms`)
    processingQueue.delete(chatId)
    
    // Проверяем, есть ли сообщения в очереди ожидания
    const waiting = waitingQueue.get(chatId)
    if (waiting && waiting.length > 0) {
      const nextMessageId = waiting.shift()!
      console.log(`[queue] Следующее сообщение в очереди: chatId=${chatId}, messageId=${nextMessageId}`)
      if (waiting.length === 0) {
        waitingQueue.delete(chatId)
      }
    }
  }
}

/**
 * Добавляет сообщение в очередь ожидания
 */
export function addToQueue(chatId: string, messageId: string): void {
  if (!waitingQueue.has(chatId)) {
    waitingQueue.set(chatId, [])
  }
  const queue = waitingQueue.get(chatId)!
  queue.push(messageId)
  console.log(`[queue] Сообщение добавлено в очередь: chatId=${chatId}, messageId=${messageId}, позиция=${queue.length}`)
}

/**
 * Проверяет, есть ли сообщения в очереди ожидания
 */
export function hasWaitingMessages(chatId: string): boolean {
  const queue = waitingQueue.get(chatId)
  return queue ? queue.length > 0 : false
}

/**
 * Получает следующее сообщение из очереди
 */
export function getNextFromQueue(chatId: string): string | null {
  const queue = waitingQueue.get(chatId)
  if (queue && queue.length > 0) {
    return queue[0]
  }
  return null
}

/**
 * Очищает очередь для чата (в случае ошибки)
 */
export function clearQueue(chatId: string): void {
  processingQueue.delete(chatId)
  waitingQueue.delete(chatId)
  console.log(`[queue] Очередь очищена для chatId=${chatId}`)
}
