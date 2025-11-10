#!/usr/bin/env tsx

/**
 * Скрипт для настройки webhook для Telegram бота
 * Использование:
 *   npm run webhook:set <webhook_url>
 *   или
 *   npm run webhook:set (использует localhost:3002)
 */

import { config } from 'dotenv'
config()

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN

if (!TELEGRAM_BOT_TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN не найден в .env файле')
  process.exit(1)
}

const webhookUrl = process.argv[2] || 'http://localhost:3002/api/tg/webhook'

async function setupWebhook() {
  try {
    console.log(`🔧 Настройка webhook для бота...`)
    console.log(`📍 URL: ${webhookUrl}`)

    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook`
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: webhookUrl,
      }),
    })

    const data = await response.json()

    if (data.ok) {
      console.log('✅ Webhook успешно установлен!')
      console.log(`📋 Детали:`, JSON.stringify(data, null, 2))
    } else {
      console.error('❌ Ошибка при установке webhook:', data.description)
      process.exit(1)
    }
  } catch (error) {
    console.error('❌ Ошибка:', error)
    process.exit(1)
  }
}

async function getWebhookInfo() {
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo`
    const response = await fetch(url)
    const data = await response.json()
    
    if (data.ok) {
      console.log('\n📊 Текущая информация о webhook:')
      console.log(JSON.stringify(data.result, null, 2))
    }
  } catch (error) {
    console.error('Ошибка при получении информации о webhook:', error)
  }
}

// Сначала показываем текущую информацию
getWebhookInfo().then(() => {
  setupWebhook()
})

