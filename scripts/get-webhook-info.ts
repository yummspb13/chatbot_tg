#!/usr/bin/env tsx

/**
 * Скрипт для получения информации о текущем webhook
 */

import { config } from 'dotenv'
config()

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN

if (!TELEGRAM_BOT_TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN не найден в .env файле')
  process.exit(1)
}

async function getWebhookInfo() {
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo`
    const response = await fetch(url)
    const data = await response.json()
    
    if (data.ok) {
      const info = data.result
      console.log('📊 Информация о webhook:')
      console.log(`   URL: ${info.url || 'не установлен'}`)
      console.log(`   Ожидает подтверждения: ${info.pending_update_count || 0} обновлений`)
      if (info.last_error_date) {
        console.log(`   ⚠️  Последняя ошибка: ${new Date(info.last_error_date * 1000).toLocaleString()}`)
        console.log(`   Сообщение об ошибке: ${info.last_error_message}`)
      }
      if (info.max_connections) {
        console.log(`   Макс. соединений: ${info.max_connections}`)
      }
    } else {
      console.error('❌ Ошибка:', data.description)
    }
  } catch (error) {
    console.error('❌ Ошибка при получении информации:', error)
    process.exit(1)
  }
}

getWebhookInfo()

