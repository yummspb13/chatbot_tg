#!/usr/bin/env tsx

/**
 * Диагностика проблемы с получением сообщений из каналов
 */

import { config } from 'dotenv'
config()

import { getBot } from '@/lib/telegram/bot'
import { prisma } from '@/lib/db/prisma'
import { getBotSettings } from '@/lib/telegram/bot'

async function diagnose() {
  console.log('🔍 ДИАГНОСТИКА ПРОБЛЕМЫ С КАНАЛАМИ')
  console.log('═══════════════════════════════════════════════════════════')
  console.log('')

  const bot = getBot()

  // 1. Проверка webhook
  console.log('1️⃣ Проверка webhook...')
  try {
    const webhookInfo = await bot.telegram.getWebhookInfo()
    console.log('   URL:', webhookInfo.url || 'не установлен')
    console.log('   Pending updates:', webhookInfo.pending_update_count)
    
    if (webhookInfo.url && webhookInfo.url !== '') {
      console.log('   ⚠️⚠️⚠️ WEBHOOK УСТАНОВЛЕН! ⚠️⚠️⚠️')
      console.log('   ❌ Если webhook установлен, polling НЕ РАБОТАЕТ!')
      console.log('   💡 Решение: удалите webhook командой: npm run webhook:delete')
      console.log('   💡 Или используйте webhook вместо polling')
    } else {
      console.log('   ✅ Webhook не установлен, polling должен работать')
    }
  } catch (error: any) {
    console.log('   ❌ Ошибка проверки webhook:', error.message)
  }
  console.log('')

  // 2. Проверка статуса бота
  console.log('2️⃣ Проверка статуса бота...')
  const settings = await getBotSettings()
  console.log('   isRunning:', settings.isRunning ? '✅ Запущен' : '❌ Остановлен')
  if (!settings.isRunning) {
    console.log('   💡 Запустите бота командой /start')
  }
  console.log('   mode:', settings.mode)
  console.log('')

  // 3. Проверка каналов в базе
  console.log('3️⃣ Проверка каналов в базе данных...')
  const channels = await prisma.channel.findMany({
    include: {
      city: true,
    },
  })

  if (channels.length === 0) {
    console.log('   ❌ Каналы не добавлены в базу данных')
    console.log('   💡 Добавьте канал через /addchannel')
  } else {
    console.log(`   ✅ Найдено каналов: ${channels.length}`)
    
    for (const channel of channels) {
      console.log('')
      console.log(`   📺 Канал: ${channel.title}`)
      console.log(`      Chat ID: ${channel.chatId}`)
      console.log(`      Статус: ${channel.isActive ? '✅ Активен' : '❌ Неактивен'}`)
      console.log(`      Город: ${channel.city.name} (${channel.city.slug})`)
      
      if (!channel.isActive) {
        console.log('      ⚠️ Канал неактивен! Активируйте его.')
        continue
      }

      // Проверка доступа бота к каналу
      console.log('      🔍 Проверка доступа бота к каналу...')
      try {
        const chat = await bot.telegram.getChat(channel.chatId)
        console.log(`      ✅ Бот имеет доступ к каналу`)
        console.log(`      Тип чата: ${chat.type}`)
        console.log(`      Название: ${(chat as any).title || 'нет названия'}`)
        
        // Проверка прав бота
        if (chat.type === 'channel') {
          console.log(`      🔍 Проверка прав бота...`)
          console.log(`      ⚠️ Для каналов getChatMember не работает, используем другой метод`)
          
          try {
            // Для каналов проверяем права через попытку получить администраторов
            // Или просто проверяем, можем ли мы получить информацию о канале
            const botInfo = await bot.telegram.getMe()
            
            // Пробуем получить администраторов канала (работает только если бот админ)
            try {
              const admins = await bot.telegram.getChatAdministrators(channel.chatId)
              const botAdmin = admins.find(a => a.user.id === botInfo.id)
              
              if (botAdmin) {
                console.log(`      ✅ Бот является администратором канала`)
                if (botAdmin.status === 'administrator') {
                  const adminMember = botAdmin as any
                  console.log(`      Права администратора:`)
                  console.log(`         - can_post_messages: ${adminMember.can_post_messages !== false ? '✅' : '❌'}`)
                  console.log(`         - can_edit_messages: ${adminMember.can_edit_messages !== false ? '✅' : '❌'}`)
                  console.log(`         - can_delete_messages: ${adminMember.can_delete_messages !== false ? '✅' : '❌'}`)
                  
                  // Важно: для получения обновлений из каналов бот должен быть администратором
                  if (adminMember.can_post_messages === false) {
                    console.log(`      ⚠️ ВНИМАНИЕ: Бот не имеет права "can_post_messages"`)
                    console.log(`      💡 Это может быть причиной, почему не приходят обновления`)
                  }
                } else if (botAdmin.status === 'creator') {
                  console.log(`      ✅ Бот является создателем канала`)
                }
              } else {
                console.log(`      ❌ Бот НЕ найден среди администраторов!`)
                console.log(`      💡 Добавьте бота в канал как администратора`)
              }
            } catch (e: any) {
              if (e.response?.error_code === 400) {
                console.log(`      ⚠️ Не удалось проверить права (возможно, бот не админ)`)
                console.log(`      💡 Убедитесь, что бот добавлен как администратор канала`)
              } else {
                console.log(`      ⚠️ Ошибка проверки прав: ${e.message}`)
              }
            }
          } catch (e: any) {
            console.log(`      ⚠️ Ошибка проверки: ${e.message}`)
          }
        }
      } catch (error: any) {
        console.log(`      ❌ Ошибка доступа к каналу: ${error.message}`)
        if (error.response?.error_code === 400) {
          console.log(`      💡 Канал не найден или бот не добавлен в канал`)
        } else if (error.response?.error_code === 403) {
          console.log(`      💡 Бот не имеет доступа к каналу`)
        }
      }
    }
  }
  console.log('')

  // 4. Проверка информации о боте
  console.log('4️⃣ Информация о боте...')
  try {
    const botInfo = await bot.telegram.getMe()
    console.log(`   Username: @${botInfo.username}`)
    console.log(`   ID: ${botInfo.id}`)
    console.log(`   First Name: ${botInfo.first_name}`)
  } catch (error: any) {
    console.log(`   ❌ Ошибка получения информации о боте: ${error.message}`)
  }
  console.log('')

  // 5. Тест отправки сообщения (проверка прав на запись)
  console.log('5️⃣ Тест отправки сообщения в канал (проверка прав)...')
  const activeChannels = channels.filter(ch => ch.isActive)
  if (activeChannels.length > 0) {
    const testChannel = activeChannels[0]
    console.log(`   Тестирую канал: ${testChannel.title}`)
    try {
      // Пробуем отправить тестовое сообщение (но не отправляем, только проверяем права)
      // Вместо этого проверим через getChat
      const chat = await bot.telegram.getChat(testChannel.chatId)
      console.log(`   ✅ Бот имеет доступ к каналу`)
      
      // Для каналов важно: бот должен быть администратором
      // Проверяем через getChatAdministrators
      try {
        const admins = await bot.telegram.getChatAdministrators(testChannel.chatId)
        const botInfo = await bot.telegram.getMe()
        const isAdmin = admins.some(a => a.user.id === botInfo.id)
        
        if (isAdmin) {
          console.log(`   ✅ Бот является администратором`)
        } else {
          console.log(`   ❌ Бот НЕ является администратором!`)
          console.log(`   💡 Это основная причина - добавьте бота как администратора`)
        }
      } catch (e: any) {
        console.log(`   ⚠️ Не удалось проверить администраторов: ${e.message}`)
        console.log(`   💡 Возможно, бот не является администратором`)
      }
    } catch (error: any) {
      console.log(`   ❌ Ошибка доступа: ${error.message}`)
    }
  } else {
    console.log('   ⚠️ Нет активных каналов для тестирования')
  }
  console.log('')

  // 6. Важные замечания
  console.log('6️⃣ ВАЖНЫЕ ЗАМЕЧАНИЯ:')
  console.log('   📌 Telegram отправляет обновления из каналов ТОЛЬКО если:')
  console.log('      1. Бот является администратором канала (ОБЯЗАТЕЛЬНО!)')
  console.log('      2. Бот имеет право "can_post_messages" (рекомендуется)')
  console.log('      3. Webhook НЕ установлен (если используете polling)')
  console.log('      4. Канал добавлен в базу данных и активен')
  console.log('      5. Бот запущен (isRunning = true)')
  console.log('')
  console.log('   📌 КРИТИЧЕСКИ ВАЖНО:')
  console.log('      Для получения обновлений из каналов бот ДОЛЖЕН быть администратором!')
  console.log('      Просто добавление бота в канал недостаточно.')
  console.log('')
  console.log('   📌 Если все условия выполнены, но обновления не приходят:')
  console.log('      - Убедитесь, что бот запущен в режиме polling (npm run bot:polling)')
  console.log('      - Проверьте логи бота - должны появляться обновления от Telegram')
  console.log('      - Попробуйте отправить сообщение в канал и смотрите логи')
  console.log('      - Если в логах НЕТ обновлений - проблема в настройках Telegram')
  console.log('      - Если обновления есть, но не обрабатываются - смотрите детальные логи')
  console.log('')

  // 7. Рекомендации
  console.log('7️⃣ РЕКОМЕНДАЦИИ:')
  const issues: string[] = []
  
  try {
    const webhookInfo = await bot.telegram.getWebhookInfo()
    if (webhookInfo.url && webhookInfo.url !== '') {
      issues.push('Удалите webhook: npm run webhook:delete')
    }
  } catch {}
  
  if (!settings.isRunning) {
    issues.push('Запустите бота: /start')
  }
  
  if (channels.length === 0) {
    issues.push('Добавьте канал: /addchannel')
  }
  
  if (issues.length === 0) {
    console.log('   ✅ Все настройки выглядят правильно!')
    console.log('   💡 Если обновления все равно не приходят, проверьте логи бота')
    console.log('   💡 Убедитесь, что отправляете сообщение в правильный канал')
  } else {
    console.log('   ⚠️ Обнаружены проблемы:')
    issues.forEach((issue, i) => {
      console.log(`      ${i + 1}. ${issue}`)
    })
  }
  console.log('')
  console.log('═══════════════════════════════════════════════════════════')
}

diagnose()
  .then(() => {
    console.log('✅ Диагностика завершена')
    process.exit(0)
  })
  .catch((error) => {
    console.error('❌ Ошибка при диагностике:', error)
    process.exit(1)
  })

