#!/usr/bin/env tsx

/**
 * Скрипт для отладки обработки каналов
 * Показывает все активные каналы и их статус
 */

import { config } from 'dotenv'
config()

import { prisma } from '@/lib/db/prisma'
import { getBotSettings } from '@/lib/telegram/bot'

async function debugChannels() {
  console.log('🔍 Диагностика каналов и настроек бота\n')

  // Проверяем настройки бота
  const settings = await getBotSettings()
  console.log('📊 Настройки бота:')
  console.log(`   isRunning: ${settings.isRunning ? '✅ Да' : '❌ Нет'}`)
  console.log(`   mode: ${settings.mode}`)
  console.log(`   confidenceThreshold: ${settings.confidenceThreshold}`)
  console.log('')

  // Проверяем каналы
  const channels = await prisma.channel.findMany({
    where: { isActive: true },
    include: {
      city: true,
    },
  })

  console.log(`📡 Активных каналов: ${channels.length}\n`)

  if (channels.length === 0) {
    console.log('❌ Нет активных каналов!')
    console.log('💡 Добавьте канал через команду: /addchannel <slug> <ссылка>')
    return
  }

  for (const channel of channels) {
    console.log(`📋 Канал: ${channel.title}`)
    console.log(`   ID: ${channel.id}`)
    console.log(`   Chat ID: ${channel.chatId}`)
    console.log(`   Город: ${channel.city?.name || 'Не указан'}`)
    console.log(`   Активен: ${channel.isActive ? '✅' : '❌'}`)
    console.log('')
  }

  // Проверяем последние черновики
  const recentDrafts = await prisma.draftEvent.findMany({
    take: 5,
    orderBy: { createdAt: 'desc' },
    include: {
      channel: true,
    },
  })

  console.log(`📝 Последние черновики: ${recentDrafts.length}\n`)
  for (const draft of recentDrafts) {
    console.log(`   - ${draft.title} (${draft.status})`)
    console.log(`     Канал: ${draft.channel?.title || 'Неизвестен'}`)
    console.log(`     Создан: ${draft.createdAt.toLocaleString()}`)
    console.log('')
  }

  console.log('💡 Проверьте:')
  console.log('   1. Бот запущен через /start')
  console.log('   2. Канал добавлен через /addchannel')
  console.log('   3. Бот добавлен в канал как администратор')
  console.log('   4. В консоли бота есть логи обработки сообщений')
}

debugChannels().catch(console.error)

