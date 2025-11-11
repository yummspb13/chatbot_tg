#!/usr/bin/env tsx

/**
 * Скрипт для проверки статуса Worker
 * Использование: npm run check:worker:status
 */

import { config } from 'dotenv'
import { resolve } from 'path'

config({ path: resolve(__dirname, '../.env') })

const WORKER_URL = process.env.WORKER_URL || process.env.NEXT_PUBLIC_WORKER_URL || 'https://chatbot-tg.onrender.com'

async function checkWorkerStatus() {
  console.log('🔍 Проверка статуса Worker...\n')
  console.log(`📍 Worker URL: ${WORKER_URL}\n`)

  try {
    // Проверка health endpoint
    console.log('1️⃣ Проверка health endpoint...')
    const healthResponse = await fetch(`${WORKER_URL}/health`)
    if (healthResponse.ok) {
      const healthData = await healthResponse.json()
      console.log('   ✅ Worker доступен')
      console.log(`   Status: ${healthData.status}`)
      console.log(`   Timestamp: ${healthData.timestamp}`)
    } else {
      console.log(`   ❌ Worker недоступен: ${healthResponse.status}`)
      return
    }
    console.log('')

    // Проверка статуса мониторинга
    console.log('2️⃣ Проверка статуса мониторинга...')
    const statusResponse = await fetch(`${WORKER_URL}/runner/status`)
    if (statusResponse.ok) {
      const statusData = await statusResponse.json()
      
      console.log(`   isRunning: ${statusData.isRunning ? '✅ Да' : '❌ Нет'}`)
      console.log(`   monitoring.isMonitoring: ${statusData.monitoring?.isMonitoring ? '✅ Да' : '❌ Нет'}`)
      console.log(`   monitoring.isConnected: ${statusData.monitoring?.isConnected ? '✅ Да' : '❌ Нет'}`)
      console.log('')
      
      console.log('3️⃣ Проверка переменных окружения:')
      const envCheck = statusData.envCheck || {}
      console.log(`   TELEGRAM_SESSION_STRING: ${envCheck.hasSessionString ? '✅' : '❌'}`)
      console.log(`   TELEGRAM_API_ID: ${envCheck.hasApiId ? '✅' : '❌'}`)
      console.log(`   TELEGRAM_API_HASH: ${envCheck.hasApiHash ? '✅' : '❌'}`)
      console.log(`   MAIN_APP_URL: ${envCheck.hasMainAppUrl ? '✅' : '❌'}`)
      if (envCheck.mainAppUrl && envCheck.mainAppUrl !== 'NOT_SET') {
        console.log(`      Значение: ${envCheck.mainAppUrl}`)
      }
      console.log(`   BOT_API_KEY: ${envCheck.hasBotApiKey ? '✅' : '❌'}`)
      console.log(`   MONITOR_CHANNELS: ${envCheck.hasMonitorChannels ? '✅' : '❌'}`)
      console.log('')

      // Диагностика
      if (!statusData.isRunning) {
        console.log('⚠️  Worker не запущен!')
        console.log('   Запустите: POST /runner/start')
        console.log('   Или через curl:')
        console.log(`   curl -X POST ${WORKER_URL}/runner/start`)
        console.log('')
      } else if (!statusData.monitoring?.isMonitoring) {
        console.log('⚠️  Мониторинг не запущен!')
        console.log('   Возможные причины:')
        if (!envCheck.hasSessionString) {
          console.log('   - TELEGRAM_SESSION_STRING не установлен')
        }
        if (!envCheck.hasMainAppUrl) {
          console.log('   - MAIN_APP_URL не установлен')
        }
        if (!envCheck.hasBotApiKey) {
          console.log('   - BOT_API_KEY не установлен')
        }
        console.log('   Проверьте логи Worker для деталей')
        console.log('')
      } else if (!statusData.monitoring?.isConnected) {
        console.log('⚠️  Worker не подключен к Telegram!')
        console.log('   Возможные причины:')
        console.log('   - Проблемы с TELEGRAM_SESSION_STRING')
        console.log('   - Проблемы с подключением к Telegram')
        console.log('   Проверьте логи Worker для деталей')
        console.log('')
      } else {
        console.log('✅ Worker работает правильно!')
        console.log('   Мониторинг запущен и подключен к Telegram')
        console.log('')
      }
    } else {
      console.log(`   ❌ Не удалось получить статус: ${statusResponse.status}`)
      const errorText = await statusResponse.text()
      console.log(`   Ошибка: ${errorText.substring(0, 200)}`)
      console.log('')
    }
  } catch (error: any) {
    console.error('❌ Ошибка при проверке Worker:')
    console.error(`   ${error.message}`)
    if (error.code === 'ENOTFOUND') {
      console.error('   💡 Worker URL недоступен. Проверьте WORKER_URL в .env')
    }
    console.error('')
  }
}

checkWorkerStatus()

