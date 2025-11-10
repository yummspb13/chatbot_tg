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
import { runnerRouter } from './routes/runner'
import { channelsRouter } from './routes/channels'

config()

const app = express()
// Используем PORT для Railway/Fly.io, или WORKER_PORT для локальной разработки
const PORT = process.env.PORT || process.env.WORKER_PORT || 3001

app.use(cors())
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

app.listen(PORT, () => {
  console.log('')
  console.log('═══════════════════════════════════════════════════════════')
  console.log('🚀 Telegram Client API Worker запущен')
  console.log(`   Порт: ${PORT}`)
  console.log(`   Время: ${new Date().toISOString()}`)
  console.log('═══════════════════════════════════════════════════════════')
  console.log('')
})

