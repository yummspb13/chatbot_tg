#!/usr/bin/env tsx

/**
 * Worker для Telegram Client API (MTProto)
 * Постоянный процесс, который держит MTProto-соединение
 * Работает на VM/Render/Fly/Railway (не на Vercel!)
 */

import express from 'express'
import cors from 'cors'
import { config } from 'dotenv'
import { qrAuthRouter } from './routes/qr-auth'
import { runnerRouter, setRunning } from './routes/runner'
import { channelsRouter } from './routes/channels'
import { startMonitoring } from './monitor'

config()

const app = express()
// Используем PORT для Railway/Fly.io, или WORKER_PORT для локальной разработки
const PORT = process.env.PORT || process.env.WORKER_PORT || 3001

// Настройка CORS с явным указанием origin
app.use(cors({
  origin: [
    'https://chatbot-tg.vercel.app',
    'https://chatbot-tg.vercel.app',
    /\.vercel\.app$/,
    'http://localhost:3000',
    'http://localhost:3001',
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}))

// Обработка preflight запросов
app.options('*', cors())

app.use(express.json())

// Root path
app.get('/', (req, res) => {
  res.json({ 
    service: 'Afisha Bot Worker',
    status: 'running',
    timestamp: new Date().toISOString(),
    endpoints: {
      health: '/health',
      qrAuth: '/auth/qr/start',
      runner: '/runner/status'
    }
  })
})

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// Routes
app.use('/auth/qr', qrAuthRouter)
app.use('/runner', runnerRouter)
app.use('/channels', channelsRouter)

app.listen(PORT, async () => {
  console.log('')
  console.log('═══════════════════════════════════════════════════════════')
  console.log('🚀 Telegram Client API Worker запущен')
  console.log(`   Порт: ${PORT}`)
  console.log(`   Время: ${new Date().toISOString()}`)
  console.log('═══════════════════════════════════════════════════════════')
  console.log('')
  
  // Автоматически запускаем мониторинг при старте сервера
  console.log('🔄 Автоматический запуск мониторинга...')
  try {
    setRunning(true)
    const monitoringStarted = await startMonitoring()
    if (monitoringStarted) {
      console.log('✅ Мониторинг запущен автоматически')
    } else {
      console.warn('⚠️ Не удалось запустить мониторинг автоматически')
      console.warn('   Запустите вручную: POST /runner/start')
      setRunning(false)
    }
  } catch (error: any) {
    console.error('❌ Ошибка автоматического запуска мониторинга:', error.message)
    console.error('   Запустите вручную: POST /runner/start')
    setRunning(false)
  }
})

