#!/usr/bin/env tsx

/**
 * Скрипт для проверки webhook бота
 */

import { config } from 'dotenv'
import { resolve } from 'path'

// Загружаем переменные окружения
config({ path: resolve(__dirname, '../.env') })

const botToken = process.env.TELEGRAM_BOT_TOKEN

if (!botToken) {
  console.error('❌ TELEGRAM_BOT_TOKEN не установлен в переменных окружения')
  console.error('   Установите его в .env файле или через export TELEGRAM_BOT_TOKEN=...')
  process.exit(1)
}

async function checkWebhook() {
  console.log('🔍 Проверяю webhook бота...')
  console.log('')

  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/getWebhookInfo`)
    const data = await response.json()

    if (data.ok) {
      console.log('✅ Webhook информация:')
      console.log('')
      console.log(`   URL: ${data.result.url || 'не установлен'}`)
      console.log(`   Pending updates: ${data.result.pending_update_count || 0}`)
      console.log(`   Last error date: ${data.result.last_error_date ? new Date(data.result.last_error_date * 1000).toISOString() : 'нет'}`)
      console.log(`   Last error message: ${data.result.last_error_message || 'нет'}`)
      console.log(`   Max connections: ${data.result.max_connections || 'не указано'}`)
      console.log('')

      if (!data.result.url) {
        console.log('⚠️ Webhook не установлен!')
        console.log('')
        console.log('Установите webhook командой:')
        console.log(`   npm run webhook:set:prod`)
        console.log('')
      } else if (data.result.url !== 'https://chatbot-tg.vercel.app/api/tg/webhook') {
        console.log('⚠️ Webhook установлен на другой URL!')
        console.log(`   Текущий: ${data.result.url}`)
        console.log(`   Ожидаемый: https://chatbot-tg.vercel.app/api/tg/webhook`)
        console.log('')
        console.log('Обновите webhook командой:')
        console.log(`   npm run webhook:set:prod`)
        console.log('')
      } else {
        console.log('✅ Webhook настроен правильно!')
      }
    } else {
      console.error('❌ Ошибка получения информации о webhook:')
      console.error(`   ${data.description}`)
    }
  } catch (error: any) {
    console.error('❌ Ошибка при проверке webhook:')
    console.error(`   ${error.message}`)
  }
}

checkWebhook()

