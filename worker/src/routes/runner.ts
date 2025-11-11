/**
 * Управление воркером (start/stop)
 */

import { Router } from 'express'
import { startMonitoring, stopMonitoring, getMonitoringStatus } from '../monitor'

const router = Router()

let isRunning = false

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
  return res.json({ 
    isRunning,
    monitoring: monitoringStatus,
    timestamp: new Date().toISOString()
  })
})

export { router as runnerRouter }

