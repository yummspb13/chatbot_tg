#!/usr/bin/env tsx

/**
 * Удаление webhook (переключение на polling)
 */

import { config } from 'dotenv'
config()

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN

if (!TELEGRAM_BOT_TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN не найден в .env файле')
  process.exit(1)
}

async function deleteWebhook() {
  try {
    console.log('🔧 Удаляю webhook...')

    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteWebhook`
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        drop_pending_updates: true, // Удалить ожидающие обновления
      }),
    })

    const data = await response.json()

    if (data.ok) {
      console.log('✅ Webhook удален!')
      console.log('📡 Теперь можно использовать polling режим: npm run bot:polling')
    } else {
      console.error('❌ Ошибка при удалении webhook:', data.description)
      process.exit(1)
    }
  } catch (error) {
    console.error('❌ Ошибка:', error)
    process.exit(1)
  }
}

deleteWebhook()

