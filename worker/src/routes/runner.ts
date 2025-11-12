/**
 * Управление воркером (start/stop)
 */

import { Router } from 'express'
import { startMonitoring, stopMonitoring, getMonitoringStatus } from '../monitor'

const router = Router()

// Экспортируем isRunning для проверки статуса
export let isRunning = false

// Функция для установки статуса (используется при автозапуске)
export function setRunning(value: boolean) {
  isRunning = value
}

/**
 * POST /runner/start
 * Запускает воркер
 */
router.post('/start', async (req, res) => {
  const { history } = req.body // Опционально: обработать последние N сообщений
  
  if (isRunning) {
    return res.json({ 
      success: true, 
      message: 'Воркер уже запущен',
      isRunning: true 
    })
  }

  isRunning = true
  console.log('🚀 Воркер запущен')
  
  // Запускаем мониторинг каналов через Client API
  const monitoringStarted = await startMonitoring()
  if (!monitoringStarted) {
    console.warn('⚠️ Не удалось запустить мониторинг каналов')
    console.warn('   Проверьте:')
    console.warn('   1. TELEGRAM_SESSION_STRING установлен?')
    console.warn('   2. TELEGRAM_API_ID и TELEGRAM_API_HASH установлены?')
    console.warn('   3. Каналы добавлены в MONITOR_CHANNELS или доступны через API?')
  }
  
  return res.json({ 
    success: true, 
    message: 'Воркер запущен',
    isRunning: true,
    monitoring: monitoringStarted,
    history: history || null
  })
})

/**
 * POST /runner/stop
 * Останавливает воркер
 */
router.post('/stop', async (req, res) => {
  if (!isRunning) {
    return res.json({ 
      success: true, 
      message: 'Воркер уже остановлен',
      isRunning: false 
    })
  }

  isRunning = false
  console.log('⏹ Воркер остановлен')
  
  // Останавливаем мониторинг каналов
  await stopMonitoring()
  
  return res.json({ 
    success: true, 
    message: 'Воркер остановлен',
    isRunning: false 
  })
})

/**
 * GET /runner/status
 * Возвращает статус воркера
 */
router.get('/status', async (req, res) => {
  const monitoringStatus = getMonitoringStatus()
  
  // Проверяем переменные окружения для диагностики
  const envCheck = {
    hasSessionString: !!process.env.TELEGRAM_SESSION_STRING,
    hasApiId: !!process.env.TELEGRAM_API_ID,
    hasApiHash: !!process.env.TELEGRAM_API_HASH,
    hasMainAppUrl: !!process.env.MAIN_APP_URL,
    hasBotApiKey: !!process.env.BOT_API_KEY,
    hasMonitorChannels: !!process.env.MONITOR_CHANNELS,
    mainAppUrl: process.env.MAIN_APP_URL || 'NOT_SET',
  }
  
  return res.json({ 
    isRunning,
    monitoring: monitoringStatus,
    envCheck,
    timestamp: new Date().toISOString()
  })
})

/**
 * POST /runner/wake
 * Пробуждает воркер (проверяет статус и перезапускает мониторинг если нужно)
 * Используется для пробуждения Worker после idle timeout на Render.com
 */
router.post('/wake', async (req, res) => {
  console.log('🔔 Запрос на пробуждение Worker...')
  
  const monitoringStatus = getMonitoringStatus()
  
  // Если Worker не запущен или мониторинг не работает, запускаем заново
  if (!isRunning || !monitoringStatus.isMonitoring || !monitoringStatus.isConnected) {
    console.log('   ⚠️ Worker не работает, запускаю заново...')
    
    // Останавливаем старый мониторинг если был
    if (isRunning) {
      await stopMonitoring()
    }
    
    // Запускаем заново
    isRunning = true
    const monitoringStarted = await startMonitoring()
    
    if (monitoringStarted) {
      console.log('   ✅ Worker пробужден и мониторинг запущен')
      return res.json({
        success: true,
        message: 'Worker пробужден и мониторинг запущен',
        wasSleeping: true,
        isRunning: true,
        monitoring: monitoringStarted
      })
    } else {
      console.warn('   ⚠️ Не удалось запустить мониторинг после пробуждения')
      return res.json({
        success: false,
        message: 'Worker пробужден, но не удалось запустить мониторинг',
        wasSleeping: true,
        isRunning: true,
        monitoring: false
      })
    }
  } else {
    console.log('   ✅ Worker уже работает, пробуждение не требуется')
    return res.json({
      success: true,
      message: 'Worker уже работает',
      wasSleeping: false,
      isRunning: true,
      monitoring: monitoringStatus
    })
  }
})

export { router as runnerRouter }

