#!/usr/bin/env tsx

/**
 * Скрипт для проверки каналов в базе данных
 * Использование: npm run check:channels:db
 */

import { PrismaClient } from '@prisma/client'
import { config } from 'dotenv'
import { resolve } from 'path'

config({ path: resolve(__dirname, '../.env') })

const prisma = new PrismaClient()

async function checkChannels() {
  console.log('🔍 Проверка каналов в базе данных...\n')

  try {
    // Получаем все каналы
    const allChannels = await prisma.channel.findMany({
      include: {
        city: true,
      },
      orderBy: {
        title: 'asc',
      },
    })

    console.log(`📊 Всего каналов в базе: ${allChannels.length}\n`)

    if (allChannels.length === 0) {
      console.log('⚠️  В базе данных нет каналов!')
      console.log('   Добавьте каналы через админ-панель или напрямую в БД')
      return
    }

    // Активные каналы
    const activeChannels = allChannels.filter(ch => ch.isActive)
    console.log(`✅ Активных каналов: ${activeChannels.length}`)
    console.log(`❌ Неактивных каналов: ${allChannels.length - activeChannels.length}\n`)

    if (activeChannels.length === 0) {
      console.log('⚠️  Нет активных каналов для мониторинга!')
      console.log('   Установите isActive = true для каналов, которые нужно мониторить\n')
    }

    // Выводим список каналов
    console.log('📋 Список каналов:\n')
    allChannels.forEach((channel, index) => {
      const status = channel.isActive ? '✅' : '❌'
      console.log(`${index + 1}. ${status} ${channel.title}`)
      console.log(`   chatId: ${channel.chatId}`)
      console.log(`   isActive: ${channel.isActive}`)
      console.log(`   Город: ${channel.city?.name || 'не указан'}`)
      console.log('')
    })

    // Проверяем формат chatId
    console.log('🔍 Проверка формата chatId:\n')
    const invalidChatIds = allChannels.filter(ch => {
      // chatId должен быть строкой, начинающейся с "-100" для каналов
      return !ch.chatId.startsWith('-100') && !ch.chatId.startsWith('-')
    })

    if (invalidChatIds.length > 0) {
      console.log('⚠️  Найдены каналы с неправильным форматом chatId:')
      invalidChatIds.forEach(ch => {
        console.log(`   - ${ch.title}: ${ch.chatId} (должен начинаться с "-100")`)
      })
      console.log('')
    } else {
      console.log('✅ Все chatId в правильном формате\n')
    }

    // Рекомендации
    console.log('💡 Рекомендации:\n')
    if (activeChannels.length === 0) {
      console.log('   1. Активируйте каналы для мониторинга:')
      console.log('      UPDATE Channel SET isActive = true WHERE id = <channel_id>;')
      console.log('')
    }

    console.log('   2. Убедитесь, что аккаунт (TELEGRAM_SESSION_STRING) подписан на каналы')
    console.log('   3. Проверьте, что chatId в базе совпадает с реальным ID канала')
    console.log('   4. Перезапустите Worker после изменений:')
    console.log('      curl -X POST https://chatbot-tg.onrender.com/runner/stop')
    console.log('      curl -X POST https://chatbot-tg.onrender.com/runner/start')
    console.log('')

  } catch (error: any) {
    console.error('❌ Ошибка при проверке каналов:')
    console.error(`   ${error.message}`)
    if (error.message.includes('Can\'t reach database server')) {
      console.error('   💡 Проверьте DATABASE_URL в .env файле')
    }
  } finally {
    await prisma.$disconnect()
  }
}

checkChannels()

