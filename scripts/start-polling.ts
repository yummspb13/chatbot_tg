#!/usr/bin/env tsx

/**
 * Альтернатива webhook - использование long polling
 * Запускает бота в режиме polling (опрос сервера Telegram)
 */

import { config } from 'dotenv'
config()

import { getBot } from '@/lib/telegram/bot'
import { handleStart, handleStop, handleStatus, handleAuto, handleManual, handleSetThreshold, handleAddCity, handleAddChannel, handleListChannels, handleRemoveChannel } from '@/lib/telegram/commands'
import { handleChannelMessage } from '@/lib/telegram/messageHandler'
import { handleCallback } from '@/lib/telegram/callbackHandler'
import { getMainKeyboard } from '@/lib/telegram/keyboard'
import { startChannelMonitoring, stopChannelMonitoring } from '@/lib/telegram/client-api'
import { startChannelMonitoringSimple, stopChannelMonitoringSimple } from '@/lib/telegram/client-api-simple'

const bot = getBot()

// Регистрируем команды ПЕРВЫМИ (команды имеют приоритет)
bot.command('start', handleStart)
bot.command('stop', handleStop)
bot.command('status', handleStatus)
bot.command('auto', handleAuto)
bot.command('manual', handleManual)
bot.command('setthreshold', handleSetThreshold)
bot.command('addcity', handleAddCity)
bot.command('addchannel', handleAddChannel)
bot.command('listchannels', handleListChannels)
bot.command('removechannel', handleRemoveChannel)

// Обработка callback (кнопки в сообщениях)
bot.on('callback_query', handleCallback)

// Обработка кнопок клавиатуры (текст от кнопок)
bot.hears(['📊 Статус'], handleStatus)
bot.hears(['▶️ Запустить'], handleStart)
bot.hears(['⏹ Остановить'], handleStop)
bot.hears(['📋 Список каналов'], handleListChannels)
bot.hears(['🏙️ Города'], async (ctx) => {
  await ctx.reply('Используйте команду /addcity для добавления города')
})
bot.hears(['📡 Каналы'], async (ctx) => {
  await ctx.reply('Используйте команду /addchannel для добавления канала\nИли /listchannels для просмотра списка')
})
bot.hears(['⚙️ Настройки'], async (ctx) => {
  await ctx.reply('Настройки бота:\n/auto - автоматический режим\n/manual - ручной режим\n/setthreshold <0.0-1.0> - порог уверенности')
})
bot.hears(['🎓 Обучение'], async (ctx) => {
  await ctx.reply('Статистика обучения доступна через команду /status')
})
bot.hears(['📝 Черновики'], async (ctx) => {
  await ctx.reply('Черновики мероприятий будут отображаться в админ-панели (в разработке)')
})

// Обработка ВСЕХ возможных типов обновлений из каналов
// Telegram может отправлять сообщения из каналов в разных форматах

// 1. channel_post - основной тип для сообщений из каналов
bot.on('channel_post', async (ctx) => {
  console.log('📢 [HANDLER] Получен channel_post!')
  console.log('   Message ID:', ctx.channelPost?.message_id)
  console.log('   Chat ID:', ctx.chat?.id)
  console.log('   Chat Type:', ctx.chat?.type)
  console.log('   Text:', (ctx.channelPost as any)?.text?.substring(0, 100) || 'нет текста')
  await handleChannelMessage(ctx as any)
})

// 2. edited_channel_post - отредактированные сообщения из каналов
bot.on('edited_channel_post', async (ctx) => {
  console.log('📢 [HANDLER] Получен edited_channel_post!')
  console.log('   Message ID:', (ctx as any).editedChannelPost?.message_id)
  console.log('   Chat ID:', ctx.chat?.id)
  await handleChannelMessage(ctx as any)
})

// 3. message из канала (если приходит как message, а не channel_post)
bot.on('message', async (ctx) => {
  // Примечание: сообщения из каналов обрабатываются через 'channel_post' выше
  // Здесь обрабатываются только личные сообщения и сообщения из групп
  
  // Обработка пересланных сообщений из каналов (для ручного пересыла)
  const messageAny = ctx.message as any
  if (messageAny && (messageAny.forward_from_chat || messageAny.forward_from)) {
    console.log('📨 [HANDLER] Обнаружено пересланное сообщение!')
    console.log('   forward_from_chat:', messageAny.forward_from_chat ? 'есть' : 'нет')
    console.log('   forward_from:', messageAny.forward_from ? 'есть' : 'нет')
    
    const forwardedChat = messageAny.forward_from_chat
    if (forwardedChat) {
      console.log('   Тип пересланного чата:', (forwardedChat as any).type)
      console.log('   Chat ID:', (forwardedChat as any).id)
      console.log('   Chat Title:', (forwardedChat as any).title || 'нет названия')
      
      // Проверяем, что это канал
      if ((forwardedChat as any).type === 'channel') {
        console.log('📨 [HANDLER] ✅ Это пересланное сообщение из канала!')
        const chatTitle = (forwardedChat as any).title || (forwardedChat as any).id
        console.log('   Исходный канал:', chatTitle)
        console.log('   Chat ID:', (forwardedChat as any).id)
        
        // Создаем контекст, имитирующий сообщение из канала
        const channelCtx = {
          ...ctx,
          chat: forwardedChat,
          message: {
            ...messageAny,
            // Используем текст пересланного сообщения
            text: messageAny.text || messageAny.caption || '',
            caption: messageAny.caption || messageAny.text || '',
            message_id: messageAny.message_id,
          },
        } as any
        
        await handleChannelMessage(channelCtx)
        return
      } else {
        console.log('   ⚠️ Пересланное сообщение не из канала, тип:', (forwardedChat as any).type)
      }
    } else {
      console.log('   ⚠️ forward_from_chat отсутствует, но есть forward_from')
    }
  }
  
  // Для личных сообщений, если это не команда и не кнопка, показываем подсказку
  const text = 'text' in ctx.message ? ctx.message.text : ''
  if (ctx.chat?.type === 'private' && text && !text.startsWith('/')) {
    // Проверяем, не обработано ли уже через bot.hears
    // Если дошли сюда, значит это не кнопка - показываем подсказку
    await ctx.reply('Используйте команды для управления ботом. Список команд: /start')
  }
})

// 4. edited_message из канала
// Примечание: отредактированные сообщения из каналов обрабатываются через 'edited_channel_post' выше
bot.on('edited_message', async (ctx) => {
  // Обработка отредактированных сообщений из групп/личных чатов
  // Команды обработаются через bot.command выше
})

console.log('🤖 Бот запущен в режиме polling (long polling)')
console.log('📡 Ожидаю обновления от Telegram...')
console.log('⚠️  Для остановки нажмите Ctrl+C')
console.log('')

// Добавляем обработчики для отладки - ПЕРВЫМ, чтобы видеть ВСЕ обновления
bot.use((ctx, next) => {
  console.log('')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('📥 ПОЛУЧЕНО ОБНОВЛЕНИЕ ОТ TELEGRAM')
  console.log('   Update Type:', ctx.updateType)
  console.log('   Update ID:', (ctx.update as any).update_id)
  console.log('   Timestamp:', new Date().toISOString())
  
  // Показываем ВСЕ ключи update для отладки
  const updateKeys = Object.keys(ctx.update || {})
  console.log('   Все ключи update:', updateKeys)
  
  // Показываем полный update (первые 500 символов)
  console.log('   Полный update (первые 500 символов):')
  console.log('   ', JSON.stringify(ctx.update, null, 2).substring(0, 500))
  
  if (ctx.chat) {
    console.log('   Chat Type:', ctx.chat.type)
    console.log('   Chat ID:', ctx.chat.id)
    console.log('   Chat Title:', (ctx.chat as any).title || 'нет названия')
  } else {
    console.log('   ⚠️ Chat отсутствует в контексте')
  }
  
  // Детальная информация о типе обновления
  if (ctx.updateType === 'channel_post') {
    console.log('   ⚠️⚠️⚠️ ЭТО channel_post! ⚠️⚠️⚠️')
    console.log('   channelPost:', (ctx as any).channelPost ? 'есть' : 'нет')
    if ((ctx as any).channelPost) {
      const cp = (ctx as any).channelPost
      console.log('   channelPost.message_id:', cp.message_id)
      console.log('   channelPost keys:', Object.keys(cp))
    }
  }
  
  if (ctx.updateType === 'edited_channel_post') {
    console.log('   ⚠️⚠️⚠️ ЭТО edited_channel_post! ⚠️⚠️⚠️')
  }
  
  if (ctx.updateType === 'message') {
    console.log('   📨 Это message')
    // Примечание: message из каналов обрабатываются через 'channel_post'
    if (ctx.message) {
      console.log('   message.message_id:', ctx.message.message_id)
      console.log('   message keys:', Object.keys(ctx.message))
    }
  }
  
  if (ctx.updateType === 'edited_message') {
    console.log('   📝 Это edited_message')
    // Примечание: edited_message из каналов обрабатываются через 'edited_channel_post'
  }
  
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  
  return next()
})

// Обработка ошибок
bot.catch((err, ctx) => {
  console.error('❌ Ошибка в боте:', err)
  console.error('Context:', ctx.updateType, ctx.chat?.id)
})

// Запускаем polling с настройками для получения ВСЕХ обновлений
// Важно: указать все типы обновлений, которые могут прийти из каналов
bot.launch({
  allowedUpdates: [
    'message',                    // Обычные сообщения
    'channel_post',               // Сообщения из каналов (основной тип)
    'edited_message',             // Отредактированные сообщения
    'edited_channel_post',        // Отредактированные сообщения из каналов
    'callback_query',             // Callback от кнопок
    'inline_query',               // Inline запросы
    'chosen_inline_result',       // Выбранный inline результат
    'poll',                       // Опросы
    'poll_answer',                // Ответы на опросы
    'my_chat_member',             // Изменения статуса бота в чате
    'chat_member',                // Изменения участников чата
    'chat_join_request'           // Запросы на вступление в чат
  ]
})
  .then(async () => {
    console.log('✅ Бот успешно запущен и подключен к Telegram API')
    console.log('📋 Получаю обновления: message, channel_post, callback_query')
    console.log('💡 Отправьте сообщение в канал и проверьте логи выше')
    console.log('')
    
    // Запускаем мониторинг через Client API для каналов конкурентов
    console.log('🔍 Запускаю мониторинг через Client API...')
    try {
      // Пробуем упрощенный способ (со стандартными credentials)
      await startChannelMonitoringSimple()
    } catch (error) {
      console.error('⚠️ Ошибка запуска упрощенного Client API, пробую стандартный...')
      try {
        await startChannelMonitoring()
      } catch (error2) {
        console.error('⚠️ Ошибка запуска Client API мониторинга:', error2)
        console.error('   Это нормально, если Client API не настроен')
        console.error('   💡 Используйте ручной способ пересылки или настройте сессию')
      }
    }
  })
  .catch((error) => {
    console.error('❌ Ошибка при запуске бота:', error)
    console.error('💡 Проверьте TELEGRAM_BOT_TOKEN в .env файле')
    process.exit(1)
  })

// Graceful shutdown
process.once('SIGINT', async () => {
  console.log('\n⏹ Останавливаю бота...')
  await stopChannelMonitoringSimple()
  await stopChannelMonitoring()
  bot.stop('SIGINT')
})
process.once('SIGTERM', async () => {
  console.log('\n⏹ Останавливаю бота...')
  await stopChannelMonitoringSimple()
  await stopChannelMonitoring()
  bot.stop('SIGTERM')
})

