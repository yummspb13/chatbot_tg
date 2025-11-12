/**
 * Утилита для пробуждения Worker
 * Вызывается когда получаем сообщение, но Worker может быть "уснувшим"
 */

const WORKER_URL = process.env.NEXT_PUBLIC_WORKER_URL || process.env.WORKER_URL || 'http://localhost:3001'

/**
 * Пробуждает Worker, если он уснул
 * @returns true если Worker был пробужден или уже работал
 */
export async function wakeWorkerIfNeeded(): Promise<boolean> {
  try {
    console.log(`[wakeWorker] Проверяю статус Worker: ${WORKER_URL}`)
    
    // Сначала проверяем статус
    const statusResponse = await fetch(`${WORKER_URL}/runner/status`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
      // Короткий timeout для быстрой проверки
      signal: AbortSignal.timeout(5000),
    })
    
    if (!statusResponse.ok) {
      console.warn(`[wakeWorker] Не удалось проверить статус Worker: ${statusResponse.status}`)
      // Пытаемся пробудить в любом случае
      return await tryWakeWorker()
    }
    
    const status = await statusResponse.json()
    
    // Если Worker работает и мониторинг активен, ничего не делаем
    if (status.isRunning && status.monitoring?.isMonitoring && status.monitoring?.isConnected) {
      console.log(`[wakeWorker] ✅ Worker уже работает`)
      return true
    }
    
    // Если Worker не работает или мониторинг не активен, пробуждаем
    console.log(`[wakeWorker] ⚠️ Worker не работает или мониторинг не активен, пробуждаю...`)
    return await tryWakeWorker()
    
  } catch (error: any) {
    // Если не удалось проверить статус (Worker может быть уснувшим), пытаемся пробудить
    if (error.name === 'AbortError' || error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
      console.warn(`[wakeWorker] Worker недоступен (возможно уснул), пытаюсь пробудить...`)
      return await tryWakeWorker()
    }
    
    console.error(`[wakeWorker] Ошибка проверки статуса Worker:`, error.message)
    return false
  }
}

/**
 * Пытается пробудить Worker
 */
async function tryWakeWorker(): Promise<boolean> {
  try {
    console.log(`[wakeWorker] Отправляю запрос на пробуждение: ${WORKER_URL}/runner/wake`)
    
    const wakeResponse = await fetch(`${WORKER_URL}/runner/wake`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      // Увеличенный timeout для пробуждения (Render.com может долго просыпаться)
      signal: AbortSignal.timeout(30000),
    })
    
    if (!wakeResponse.ok) {
      console.error(`[wakeWorker] ❌ Ошибка пробуждения Worker: ${wakeResponse.status}`)
      return false
    }
    
    const result = await wakeResponse.json()
    
    if (result.success) {
      if (result.wasSleeping) {
        console.log(`[wakeWorker] ✅ Worker был пробужден`)
      } else {
        console.log(`[wakeWorker] ✅ Worker уже работал`)
      }
      return true
    } else {
      console.warn(`[wakeWorker] ⚠️ Worker пробужден, но мониторинг не запустился`)
      return false
    }
    
  } catch (error: any) {
    if (error.name === 'AbortError') {
      console.error(`[wakeWorker] ❌ Timeout при пробуждении Worker (30s)`)
    } else {
      console.error(`[wakeWorker] ❌ Ошибка пробуждения Worker:`, error.message)
    }
    return false
  }
}

