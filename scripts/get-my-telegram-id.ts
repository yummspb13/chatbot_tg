#!/usr/bin/env tsx

/**
 * Скрипт для получения вашего Telegram User ID
 * Отправьте боту любое сообщение, и этот скрипт покажет ваш ID
 */

import { config } from 'dotenv'
config()

import { getBot } from '@/lib/telegram/bot'

const bot = getBot()

// Обработчик всех сообщений для получения ID
bot.on('message', (ctx) => {
  const userId = ctx.from?.id
  const username = ctx.from?.username
  const firstName = ctx.from?.first_name
  const chatId = ctx.chat?.id
  const chatType = ctx.chat?.type

  const message = `
📋 Ваши Telegram данные:

👤 User ID: ${userId}
👤 Username: @${username || 'не указан'}
👤 Имя: ${firstName || 'не указано'}
💬 Chat ID: ${chatId}
💬 Тип чата: ${chatType}

🔑 Добавьте в .env:
TELEGRAM_ADMIN_CHAT_ID=${userId}
`

  ctx.reply(message)
})

console.log('🤖 Бот запущен для получения вашего Telegram ID')
console.log('📱 Отправьте боту любое сообщение в Telegram')
console.log('⚠️  Для остановки нажмите Ctrl+C')

bot.launch()

process.once('SIGINT', () => {
  console.log('\n⏹ Останавливаю бота...')
  bot.stop('SIGINT')
})
process.once('SIGTERM', () => {
  console.log('\n⏹ Останавливаю бота...')
  bot.stop('SIGTERM')
})

