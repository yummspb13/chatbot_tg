/**
 * Регистрация обработчиков для webhook режима
 * Используется в app/api/tg/webhook/route.ts
 */

import { getBot } from './bot'
import { handleStart, handleStop, handleStatus, handleAuto, handleManual, handleSetThreshold, handleAddCity, handleAddChannel, handleListChannels, handleRemoveChannel } from './commands'
import { handleChannelMessage } from './messageHandler'
import { handleCallback } from './callbackHandler'

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

  // Обработка обычных сообщений (может быть из канала)
  bot.on('message', async (ctx) => {
    // Если это сообщение из канала
    if (ctx.chat?.type === 'channel') {
      await handleChannelMessage(ctx)
      return
    }
    
    // Для личных сообщений команды обработаются через bot.command выше
  })

  // Обработка отредактированных сообщений
  bot.on('edited_message', async (ctx) => {
    if (ctx.chat?.type === 'channel') {
      await handleChannelMessage(ctx as any)
    }
  })
}

// Регистрируем обработчики при импорте модуля
registerWebhookHandlers()

