#!/usr/bin/env tsx

/**
 * Скрипт для проверки настроек канала и бота
 */

import { config } from 'dotenv'
config()

import { getBot } from '@/lib/telegram/bot'
import { prisma } from '@/lib/db/prisma'
import { getBotSettings } from '@/lib/telegram/bot'

async function checkSetup() {
  console.log('🔍 Проверка настроек бота и каналов...')
  console.log('')

  // 1. Проверка токена
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) {
    console.error('❌ TELEGRAM_BOT_TOKEN не установлен в .env')
    return
  }
  console.log('✅ TELEGRAM_BOT_TOKEN установлен')

  // 2. Проверка админского чата
  const adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID
  if (!adminChatId) {
    console.error('❌ TELEGRAM_ADMIN_CHAT_ID не установлен в .env')
  } else {
    console.log('✅ TELEGRAM_ADMIN_CHAT_ID установлен:', adminChatId)
  }

  // 3. Проверка OpenAI
  const openaiKey = process.env.OPENAI_API_KEY
  if (!openaiKey) {
    console.error('❌ OPENAI_API_KEY не установлен в .env')
  } else {
    console.log('✅ OPENAI_API_KEY установлен')
  }

  // 4. Проверка статуса бота
  console.log('')
  console.log('📊 Статус бота:')
  const settings = await getBotSettings()
  console.log('   isRunning:', settings.isRunning ? '✅ Запущен' : '❌ Остановлен')
  console.log('   mode:', settings.mode)
  console.log('   confidenceThreshold:', settings.confidenceThreshold)

  // 5. Проверка каналов
  console.log('')
  console.log('📡 Каналы в базе данных:')
  const channels = await prisma.channel.findMany({
    include: {
      city: true,
    },
  })

  if (channels.length === 0) {
    console.log('   ⚠️ Каналы не добавлены. Используйте /addchannel')
  } else {
    for (const channel of channels) {
      console.log('')
      console.log(`   📺 ${channel.title}`)
      console.log(`      Chat ID: ${channel.chatId}`)
      console.log(`      Город: ${channel.city.name} (${channel.city.slug})`)
      console.log(`      Статус: ${channel.isActive ? '✅ Активен' : '❌ Неактивен'}`)
      
      // Проверяем доступ бота к каналу
      try {
        const bot = getBot()
        const chat = await bot.telegram.getChat(channel.chatId)
        console.log(`      Доступ бота: ✅ Бот имеет доступ к каналу`)
        console.log(`      Тип чата: ${chat.type}`)
        
        // Проверяем, является ли бот администратором
        if (chat.type === 'channel') {
          try {
            const member = await bot.telegram.getChatMember(channel.chatId, (await bot.telegram.getMe()).id)
            if (member.status === 'administrator' || member.status === 'creator') {
              console.log(`      Роль бота: ✅ Администратор`)
            } else {
              console.log(`      Роль бота: ⚠️ ${member.status} (нужны права администратора!)`)
            }
          } catch (e: any) {
            console.log(`      Роль бота: ❌ Ошибка проверки: ${e.message}`)
          }
        }
      } catch (error: any) {
        console.log(`      Доступ бота: ❌ Ошибка: ${error.message}`)
        console.log(`      💡 Убедитесь, что бот добавлен в канал как администратор`)
      }
    }
  }

  console.log('')
  console.log('💡 Рекомендации:')
  if (!settings.isRunning) {
    console.log('   1. Запустите бота командой /start')
  }
  if (channels.length === 0) {
    console.log('   2. Добавьте канал через /addchannel')
  }
  if (channels.some(ch => !ch.isActive)) {
    console.log('   3. Активируйте неактивные каналы')
  }
  console.log('   4. Убедитесь, что бот добавлен в канал как администратор')
  console.log('')
}

checkSetup()
  .then(() => {
    console.log('✅ Проверка завершена')
    process.exit(0)
  })
  .catch((error) => {
    console.error('❌ Ошибка при проверке:', error)
    process.exit(1)
  })

