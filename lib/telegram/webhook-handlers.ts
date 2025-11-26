/**
 * Регистрация обработчиков для webhook режима
 * Используется в app/api/tg/webhook/route.ts
 */

import { getBot } from './bot'
import { handleStart, handleStop, handleStatus, handleAuto, handleManual, handleSetThreshold, handleAddCity, handleAddChannel, handleListChannels, handleRemoveChannel, handleWorker } from './commands'
import { handleChannelMessage } from './messageHandler'
import { handleCallback } from './callbackHandler'
import { memoryLogger } from '@/lib/logging/memory-logger'

/**
 * Регистрирует все обработчики для бота
 * Вызывается один раз при инициализации
 */
export function registerWebhookHandlers() {
  const bot = getBot()

  // Регистрируем команды
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

  // Обработка сообщений из каналов
  bot.on('channel_post', async (ctx) => {
    await handleChannelMessage(ctx as any)
  })

  // Обработка отредактированных сообщений из каналов
  bot.on('edited_channel_post', async (ctx) => {
    await handleChannelMessage(ctx as any)
  })

  // Обработка обычных сообщений
  // Примечание: сообщения из каналов обрабатываются через 'channel_post' выше
  // Здесь обрабатываются только личные сообщения и пересланные сообщения из каналов
  
  // Обработка пересланных сообщений из каналов (для ручного пересыла)
  // И обработка сообщений от worker'а (которые приходят как message с chat.type === 'channel')
  bot.on('message', async (ctx) => {
    const logPrefix = `[${new Date().toISOString()}]`
    
    // Обработка сообщений из каналов (от worker'а)
    // Worker отправляет сообщения как message с chat.type === 'channel'
    if (ctx.message && ctx.chat && (ctx.chat as any).type === 'channel') {
      const chatId = ctx.chat.id
      const chatTitle = (ctx.chat as any).title || 'не указано'
      const messageId = ctx.message.message_id
      const textLength = (ctx.message.text || ctx.message.caption || '').length
      const hasForward = !!(ctx.message as any).forward_from_chat
      
      console.log(`${logPrefix} 📨 [HANDLER] Получено сообщение из канала (от worker)!`)
      console.log(`${logPrefix}    Chat ID: ${chatId}`)
      console.log(`${logPrefix}    Chat Title: ${chatTitle}`)
      console.log(`${logPrefix}    Message ID: ${messageId}`)
      console.log(`${logPrefix}    Text length: ${textLength}`)
      console.log(`${logPrefix}    Has forward_from_chat: ${hasForward}`)
      
      memoryLogger.info(
        `Получено сообщение из канала (от worker)`,
        { chatId, chatTitle, messageId, textLength, hasForward },
        'handler'
      )
      
      try {
      await handleChannelMessage(ctx as any)
        console.log(`${logPrefix}    ✅ handleChannelMessage завершен успешно`)
        memoryLogger.success(
          `handleChannelMessage завершен успешно`,
          { chatId, messageId },
          'handler'
        )
      } catch (error: any) {
        console.error(`${logPrefix}    ❌ Ошибка в handleChannelMessage:`, error.message)
        console.error(`${logPrefix}    Stack:`, error.stack)
        memoryLogger.error(
          `Ошибка в handleChannelMessage: ${error.message}`,
          { chatId, messageId, error: error.message, stack: error.stack },
          'handler'
        )
      }
      return
    }
    
    // Обработка пересланных сообщений из каналов
    if (ctx.message && 'forward_from_chat' in ctx.message && ctx.message.forward_from_chat) {
      const forwardedChat = ctx.message.forward_from_chat
      // Проверяем, что это канал (используем type assertion для совместимости с типами)
      if ((forwardedChat as any).type === 'channel') {
        console.log('📨 [HANDLER] Получено пересланное сообщение из канала!')
        const chatTitle = (forwardedChat as any).title || (forwardedChat as any).id
        console.log('   Исходный канал:', chatTitle)
        console.log('   Chat ID:', (forwardedChat as any).id)
        
        // Создаем контекст, имитирующий сообщение из канала
        const messageAny = ctx.message as any
        const channelCtx = {
          ...ctx,
          chat: forwardedChat,
          message: {
            ...messageAny,
            // Используем текст пересланного сообщения
            text: messageAny.text || messageAny.caption || '',
            caption: messageAny.caption || messageAny.text || '',
          },
        } as any
        
        await handleChannelMessage(channelCtx)
        return
      }
    }
    
    // Обработка личных сообщений от админа
    const text = 'text' in ctx.message ? ctx.message.text : ''
    if (ctx.chat?.type === 'private' && text && !text.startsWith('/')) {
      // Проверяем, что это сообщение от админа
      const adminId = process.env.TELEGRAM_ADMIN_CHAT_ID
      const userId = ctx.from?.id?.toString()
      
      if (adminId && userId === adminId) {
        console.log(`${logPrefix} 📨 [HANDLER] Получено сообщение от админа, обрабатываю как событие`)
        console.log(`${logPrefix}    Текст: ${text.substring(0, 100)}...`)
        
        // Проверяем, не является ли это ответом на вопрос бота (для интерактивного режима)
        const { isAnswerToQuestion } = await import('./question-handler')
        const isAnswer = await isAnswerToQuestion(
          ctx.chat.id.toString(),
          ctx.message.message_id.toString()
        )
        
        if (isAnswer) {
          // Обрабатываем как ответ на вопрос
          console.log(`${logPrefix} 📨 [HANDLER] Это ответ на вопрос бота`)
          // TODO: Обработка ответа на вопрос (будет реализовано в следующем шаге)
          await ctx.reply('Ответ получен, обрабатываю...')
          return
        }
        
        // Используем первый активный канал из базы как источник
        const { prisma } = await import('@/lib/db/prisma')
        const firstChannel = await prisma.channel.findFirst({
          where: { isActive: true },
          include: { city: true },
        })
        
        if (firstChannel) {
          console.log(`   Использую канал "${firstChannel.title}" как источник`)
          const messageAny = ctx.message as any
          const channelCtx = {
            ...ctx,
            chat: {
              id: parseInt(firstChannel.chatId),
              type: 'channel',
              title: firstChannel.title,
            },
            message: {
              ...messageAny,
              text: text,
              caption: text,
              message_id: messageAny.message_id,
            },
          } as any
          
          await handleChannelMessage(channelCtx)
          return
        } else {
          console.log('   ⚠️ Нет активных каналов в базе')
          await ctx.reply('⚠️ Нет активных каналов в базе. Добавьте канал через /addchannel')
        }
      } else {
        // Для не-админов показываем подсказку
        await ctx.reply('Используйте команды для управления ботом. Список команд: /start')
      }
    }
  })

  // Обработка отредактированных сообщений
  // Примечание: отредактированные сообщения из каналов обрабатываются через 'edited_channel_post' выше
  bot.on('edited_message', async (ctx) => {
    // Обработка отредактированных сообщений из групп/личных чатов
    // Команды обработаются через bot.command выше
  })
}

// Регистрируем обработчики при импорте модуля
registerWebhookHandlers()

