/**
 * Управление воркером (start/stop)
 */

import { Router } from 'express'

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
  
  // TODO: Запустить мониторинг каналов через Client API
  
  return res.json({ 
    success: true, 
    message: 'Воркер запущен',
    isRunning: true,
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
  
  // TODO: Остановить мониторинг каналов
  
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
  return res.json({ 
    isRunning,
    timestamp: new Date().toISOString()
  })
})

export { router as runnerRouter }

