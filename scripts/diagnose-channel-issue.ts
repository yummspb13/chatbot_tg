#!/usr/bin/env tsx

/**
 * Диагностика проблемы с чтением сообщений из каналов
 * Использование: npm run diagnose:channels
 */

import { PrismaClient } from '@prisma/client'
import { config } from 'dotenv'
import { resolve } from 'path'

config({ path: resolve(__dirname, '../.env') })

const prisma = new PrismaClient()

async function diagnoseChannelIssue() {
  console.log('🔍 Диагностика проблемы с чтением сообщений из каналов...\n')

  // 1. Проверяем каналы в базе данных
  console.log('1️⃣ Проверка каналов в базе данных:')
  const channels = await prisma.channel.findMany({
    where: {
      isActive: true,
    },
    select: {
      chatId: true,
      title: true,
      isActive: true,
    },
    orderBy: {
      title: 'asc',
    },
  })

  console.log(`   ✅ Найдено ${channels.length} активных каналов:\n`)
  channels.forEach((ch, index) => {
    console.log(`   ${index + 1}. ${ch.title}`)
    console.log(`      Chat ID: ${ch.chatId}`)
    console.log(`      Формат: ${ch.chatId.startsWith('-100') ? '✅ Правильный' : '❌ Неправильный (должен начинаться с -100)'}`)
    console.log('')
  })

  // 2. Проверяем переменные окружения
  console.log('2️⃣ Проверка переменных окружения:')
  const requiredEnvVars = [
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_API_ID',
    'TELEGRAM_API_HASH',
    'TELEGRAM_SESSION_STRING',
    'DATABASE_URL',
    'MAIN_APP_URL',
  ]

  const missingVars: string[] = []
  requiredEnvVars.forEach(varName => {
    const value = process.env[varName]
    if (value) {
      // Скрываем чувствительные данные
      const displayValue = varName.includes('TOKEN') || varName.includes('SESSION') || varName.includes('HASH')
        ? `${value.substring(0, 10)}... (установлен)`
        : value
      console.log(`   ✅ ${varName}: ${displayValue}`)
    } else {
      console.log(`   ❌ ${varName}: не установлен`)
      missingVars.push(varName)
    }
  })

  if (missingVars.length > 0) {
    console.log(`\n   ⚠️ Отсутствуют переменные: ${missingVars.join(', ')}`)
  }
  console.log('')

  // 3. Анализ проблемы
  console.log('3️⃣ Анализ проблемы:\n')
  console.log('   📋 Возможные причины, почему бот читает только один канал:\n')
  
  console.log('   🔴 Причина 1: Бот является администратором только одного канала')
  console.log('      → Telegram Bot API отправляет channel_post только для каналов, где бот админ')
  console.log('      → Решение: Добавьте бота как администратора во все каналы\n')
  
  console.log('   🔴 Причина 2: Worker не запущен или не работает')
  console.log('      → Для каналов, где бот не админ, нужен Worker через Client API')
  console.log('      → Решение: Проверьте статус Worker на Render.com\n')
  
  console.log('   🔴 Причина 3: Аккаунт Client API не подписан на все каналы')
  console.log('      → Worker получает сообщения только из каналов, на которые подписан аккаунт')
  console.log('      → Решение: Запустите npm run check:channel:subscriptions\n')
  
  console.log('   🔴 Причина 4: Worker не перезапускался после добавления каналов')
  console.log('      → Worker загружает список каналов при старте')
  console.log('      → Решение: Перезапустите Worker после изменений\n')
  
  console.log('   🔴 Причина 5: Проблема с форматом chatId')
  console.log('      → Worker может не находить канал в channelsMap из-за несовпадения формата')
  console.log('      → Решение: Проверьте логи Worker на Render.com\n')

  // 4. Рекомендации
  console.log('4️⃣ Рекомендации по исправлению:\n')
  console.log('   📝 Шаг 1: Проверьте подписки аккаунта:')
  console.log('      npm run check:channel:subscriptions\n')
  
  console.log('   📝 Шаг 2: Проверьте статус Worker:')
  console.log('      npm run check:worker:status\n')
  
  console.log('   📝 Шаг 3: Если бот может быть администратором:')
  console.log('      - Откройте каждый канал в Telegram')
  console.log('      - Добавьте бота как администратора')
  console.log('      - Дайте боту права на чтение сообщений\n')
  
  console.log('   📝 Шаг 4: Если бот не может быть администратором:')
  console.log('      - Убедитесь, что аккаунт Client API подписан на все каналы')
  console.log('      - Перезапустите Worker:')
  console.log('        curl -X POST https://chatbot-tg.onrender.com/runner/stop')
  console.log('        curl -X POST https://chatbot-tg.onrender.com/runner/start\n')
  
  console.log('   📝 Шаг 5: Проверьте логи:')
  console.log('      - Логи основного приложения на Vercel')
  console.log('      - Логи Worker на Render.com')
  console.log('      - Ищите сообщения с "Получено сообщение из канала"\n')

  // 5. Проверка формата chatId
  console.log('5️⃣ Проверка формата chatId:\n')
  const invalidChatIds = channels.filter(ch => !ch.chatId.startsWith('-100'))
  if (invalidChatIds.length > 0) {
    console.log('   ❌ Найдены каналы с неправильным форматом:')
    invalidChatIds.forEach(ch => {
      console.log(`      - ${ch.title}: ${ch.chatId}`)
    })
    console.log('')
  } else {
    console.log('   ✅ Все chatId в правильном формате\n')
  }

  await prisma.$disconnect()
}

diagnoseChannelIssue()
