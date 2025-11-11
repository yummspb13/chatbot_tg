#!/usr/bin/env tsx

/**
 * Скрипт для настройки webhook для продакшена (Vercel)
 * Использование:
 *   npm run webhook:set:prod <vercel-url>
 *   или
 *   npm run webhook:set:prod (использует VERCEL_URL из .env)
 */

import { config } from 'dotenv'
config()

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const VERCEL_URL = process.argv[2] || process.env.VERCEL_URL

if (!TELEGRAM_BOT_TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN не найден в .env файле')
  process.exit(1)
}

if (!VERCEL_URL) {
  console.error('❌ VERCEL_URL не указан')
  console.error('Использование: npm run webhook:set:prod <vercel-url>')
  console.error('Пример: npm run webhook:set:prod https://chatbot-tg.vercel.app')
  process.exit(1)
}

// Проверяем, что URL не является примером
if (VERCEL_URL.includes('your-app') || VERCEL_URL.includes('example')) {
  console.error('❌ ОШИБКА: Вы используете пример URL!')
  console.error(`   Указанный URL: ${VERCEL_URL}`)
  console.error('   Используйте реальный URL вашего Vercel приложения')
  console.error('   Пример: npm run webhook:set:prod https://chatbot-tg.vercel.app')
  process.exit(1)
}

// Убираем https:// если есть, потом добавим
const cleanUrl = VERCEL_URL.replace(/^https?:\/\//, '').replace(/\/$/, '')
const webhookUrl = `https://${cleanUrl}/api/tg/webhook`

async function setupWebhook() {
  try {
    console.log(`🔧 Настройка webhook для продакшена...`)
    console.log(`📍 URL: ${webhookUrl}`)
    console.log('')
    
    // Проверяем доступность endpoint перед установкой
    try {
      const testResponse = await fetch(`https://${cleanUrl}/api/tg/webhook`, { method: 'GET' })
      if (testResponse.ok) {
        const testData = await testResponse.json()
        console.log('✅ Webhook endpoint доступен')
        if (testData.aiProvider) {
          console.log(`   AI Provider: ${testData.aiProvider}`)
          if (testData.aiProvider === 'mock') {
            console.error('   ⚠️  WARNING: AI_PROVIDER установлен как "mock"!')
            console.error('      Измените на "openai" в Vercel Dashboard → Environment Variables')
          }
        }
        console.log('')
      } else {
        console.warn(`⚠️  Webhook endpoint вернул статус ${testResponse.status}`)
        console.warn('   Продолжаю установку webhook...')
        console.log('')
      }
    } catch (error: any) {
      console.warn(`⚠️  Не удалось проверить доступность endpoint: ${error.message}`)
      console.warn('   Продолжаю установку webhook...')
      console.log('')
    }

    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook`
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: webhookUrl,
        allowed_updates: [
          'message',
          'edited_message',
          'channel_post',
          'edited_channel_post',
          'callback_query', // Важно для обработки кнопок!
          'inline_query',
          'chosen_inline_result',
          'poll',
          'poll_answer',
          'my_chat_member',
          'chat_member',
          'chat_join_request',
        ],
      }),
    })

    const data = await response.json()

    if (data.ok) {
      console.log('✅ Webhook успешно установлен для продакшена!')
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

