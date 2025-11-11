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
        console.log(`   npm run webhook:set:prod <vercel-url>`)
        console.log('   Пример: npm run webhook:set:prod https://your-app.vercel.app')
        console.log('')
      } else {
        const url = data.result.url
        const isLocalhost = url.includes('localhost') || url.includes('127.0.0.1')
        const isVercel = url.includes('vercel.app') || url.includes('vercel.com')
        const hasCorrectPath = url.endsWith('/api/tg/webhook')
        
        if (isLocalhost) {
          console.log('❌ Webhook указывает на localhost - не подходит для продакшена!')
          console.log(`   Текущий URL: ${url}`)
          console.log('')
          console.log('Установите webhook на продакшен URL:')
          console.log(`   npm run webhook:set:prod <vercel-url>`)
          console.log('')
        } else if (!hasCorrectPath) {
          console.log('⚠️ Webhook URL не заканчивается на /api/tg/webhook')
          console.log(`   Текущий URL: ${url}`)
          console.log('')
          console.log('Обновите webhook командой:')
          console.log(`   npm run webhook:set:prod <vercel-url>`)
          console.log('')
        } else if (isVercel) {
          console.log('✅ Webhook настроен правильно для продакшена!')
          console.log(`   URL: ${url}`)
          console.log('')
        } else {
          console.log('⚠️ Webhook установлен, но URL не похож на Vercel')
          console.log(`   Текущий URL: ${url}`)
          console.log('')
          console.log('Для продакшена рекомендуется использовать Vercel URL')
          console.log('')
        }
        
        // Проверка pending updates
        if (data.result.pending_update_count > 0) {
          console.log(`⚠️ Есть ${data.result.pending_update_count} необработанных обновлений`)
          console.log('   Это может означать, что webhook не работает правильно')
          console.log('')
        }
        
        // Проверка ошибок
        if (data.result.last_error_date) {
          console.log('❌ Обнаружены ошибки webhook:')
          console.log(`   Дата последней ошибки: ${new Date(data.result.last_error_date * 1000).toISOString()}`)
          console.log(`   Сообщение: ${data.result.last_error_message || 'нет'}`)
          console.log('')
          console.log('💡 Проверьте:')
          console.log('   1. Vercel приложение работает и доступно')
          console.log('   2. Webhook endpoint отвечает: curl ' + url.replace('/api/tg/webhook', '/api/tg/webhook'))
          console.log('   3. Логи Vercel на наличие ошибок')
          console.log('')
        }
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

