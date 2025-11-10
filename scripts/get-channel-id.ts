#!/usr/bin/env tsx

/**
 * Скрипт для получения ID канала Telegram
 * Использование:
 *   npm run channel:get-id @channel_username
 *   или
 *   npm run channel:get-id https://t.me/channel_username
 */

import { config } from 'dotenv'
config()

import { getBot } from '@/lib/telegram/bot'

const bot = getBot()

async function getChannelId(usernameOrUrl: string) {
  // Извлекаем username из URL или используем напрямую
  let username = usernameOrUrl.trim()
  
  // Убираем протокол и домен
  username = username.replace(/^https?:\/\//, '')
  username = username.replace(/^t\.me\//, '')
  username = username.replace(/^web\.telegram\.org\/k\/#/, '')
  username = username.replace(/^@/, '')
  
  // Убираем все после # или /
  username = username.split('#')[0].split('/')[0]
  
  if (!username) {
    console.error('❌ Не удалось извлечь username из:', usernameOrUrl)
    console.error('\nИспользование:')
    console.error('  npm run channel:get-id @channel_username')
    console.error('  npm run channel:get-id https://t.me/channel_username')
    process.exit(1)
  }

  console.log(`🔍 Ищу канал: @${username}`)

  try {
    // Пробуем получить информацию о канале
    const chat = await bot.telegram.getChat(`@${username}`)
    
    console.log('\n✅ Информация о канале:')
    // Проверяем, что это не приватный чат (у приватных чатов нет title)
    const title = ('title' in chat && chat.title) ? chat.title : 'Не указано'
    const chatUsername = ('username' in chat && chat.username) ? chat.username : 'Не указан'
    const description = ('description' in chat && chat.description) ? chat.description : null
    
    console.log(`   Название: ${title}`)
    console.log(`   Username: @${chatUsername}`)
    console.log(`   Chat ID: ${chat.id}`)
    console.log(`   Тип: ${chat.type}`)
    
    if (description) {
      console.log(`   Описание: ${description.substring(0, 100)}...`)
    }

    console.log('\n📋 Для добавления канала используйте:')
    const titleForCommand = ('title' in chat && chat.title) ? chat.title : 'Название'
    console.log(`   /addchannel <slug_города> ${chat.id} "${titleForCommand}"`)
    
    return chat.id.toString()
  } catch (error: any) {
    console.error('\n❌ Ошибка при получении информации о канале:')
    
    if (error.response?.error_code === 400) {
      console.error('   Канал не найден или бот не добавлен в канал')
      console.error('\n💡 Что делать:')
      console.error('   1. Убедитесь, что канал существует')
      console.error('   2. Добавьте бота в канал как администратора')
      console.error('   3. Попробуйте снова')
    } else if (error.response?.error_code === 403) {
      console.error('   Бот не имеет доступа к каналу')
      console.error('\n💡 Что делать:')
      console.error('   1. Добавьте бота в канал')
      console.error('   2. Сделайте бота администратором канала')
      console.error('   3. Попробуйте снова')
    } else {
      console.error('   ', error.message)
    }
    
    process.exit(1)
  }
}

// Получаем аргумент из командной строки
const usernameOrUrl = process.argv[2]

if (!usernameOrUrl) {
  console.error('❌ Укажите username канала или ссылку')
  console.error('\nИспользование:')
  console.error('  npm run channel:get-id @channel_username')
  console.error('  npm run channel:get-id https://t.me/channel_username')
  console.error('  npm run channel:get-id https://web.telegram.org/k/#@channel_username')
  process.exit(1)
}

getChannelId(usernameOrUrl)

