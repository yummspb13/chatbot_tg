#!/usr/bin/env tsx

/**
 * Скрипт для получения ID группы Telegram
 * 
 * Использование:
 *   1. Добавьте бота в группу как администратора
 *   2. Отправьте любое сообщение в группу
 *   3. Запустите: npm run group:get-id
 * 
 * Или просто отправьте /start в группе и проверьте логи
 */

import { config } from 'dotenv'
import { Telegraf } from 'telegraf'

config()

const botToken = process.env.TELEGRAM_BOT_TOKEN

if (!botToken) {
  console.error('❌ TELEGRAM_BOT_TOKEN не установлен в .env')
  process.exit(1)
}

const bot = new Telegraf(botToken)

// Обработчик для получения ID группы
bot.on('message', (ctx) => {
  const chat = ctx.chat
  const message = ctx.message as any
  
  console.log('\n📊 ИНФОРМАЦИЯ О ЧАТЕ:')
  console.log(`   Тип: ${chat.type}`)
  console.log(`   ID: ${chat.id}`)
  
  if ('title' in chat) {
    console.log(`   Название: ${chat.title}`)
  }
  
  if ('username' in chat && chat.username) {
    console.log(`   Username: @${chat.username}`)
  }
  
  console.log('\n💡 ДЛЯ ГРУПП И СУПЕРГРУПП:')
  console.log(`   Используйте ID: ${chat.id}`)
  console.log(`   (Уже в правильном формате)`)
  
  console.log('\n📝 ДОБАВЬТЕ В .env:')
  console.log(`   TELEGRAM_PUBLISH_GROUP_ID=${chat.id}`)
  
  console.log('\n⚠️ ВАЖНО:')
  console.log('   • Бот должен быть администратором группы')
  console.log('   • Бот должен иметь права на отправку сообщений')
  
  process.exit(0)
})

console.log('🤖 Бот запущен. Отправьте любое сообщение в группу...')
console.log('   (Или отправьте /start в группе)')
console.log('')

bot.launch().catch(console.error)

// Остановка через 60 секунд, если нет сообщений
setTimeout(() => {
  console.log('\n⏱ Время ожидания истекло. Запустите скрипт снова и отправьте сообщение в группу.')
  process.exit(0)
}, 60000)

