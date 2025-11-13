#!/usr/bin/env tsx

/**
 * Скрипт для проверки подписок аккаунта Client API на каналы
 * Использование: npm run check:channel:subscriptions
 */

import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions'
import { Api } from 'telegram/tl'
import { config } from 'dotenv'
import { resolve } from 'path'
import { PrismaClient } from '@prisma/client'

config({ path: resolve(__dirname, '../.env') })

const prisma = new PrismaClient()

async function checkChannelSubscriptions() {
  console.log('🔍 Проверка подписок аккаунта на каналы...\n')

  const apiId = process.env.TELEGRAM_API_ID
  const apiHash = process.env.TELEGRAM_API_HASH
  const sessionString = process.env.TELEGRAM_SESSION_STRING

  if (!apiId || !apiHash) {
    console.error('❌ TELEGRAM_API_ID или TELEGRAM_API_HASH не установлены')
    return
  }

  if (!sessionString) {
    console.error('❌ TELEGRAM_SESSION_STRING не установлен')
    console.error('   Нужно сначала авторизоваться через QR-код')
    return
  }

  // Получаем каналы из базы данных
  const channels = await prisma.channel.findMany({
    where: {
      isActive: true,
    },
    select: {
      chatId: true,
      title: true,
    },
    orderBy: {
      title: 'asc',
    },
  })

  if (channels.length === 0) {
    console.log('⚠️ В базе данных нет активных каналов')
    await prisma.$disconnect()
    return
  }

  console.log(`📋 Найдено ${channels.length} активных каналов в базе:\n`)
  channels.forEach((ch, index) => {
    console.log(`${index + 1}. ${ch.title} (${ch.chatId})`)
  })
  console.log('')

  // Подключаемся к Telegram
  const session = new StringSession(sessionString)
  const client = new TelegramClient(session, parseInt(apiId), apiHash, {
    connectionRetries: 5,
  })

  try {
    console.log('🔌 Подключаюсь к Telegram...')
    await client.connect()
    console.log('✅ Подключен к Telegram\n')

    // Получаем информацию о себе
    const me = await client.getMe()
    console.log(`👤 Аккаунт: ${(me as any).firstName || ''} ${(me as any).lastName || ''} (@${(me as any).username || 'нет username'})`)
    console.log(`   ID: ${me.id}\n`)

    // Проверяем подписки на каждый канал
    console.log('🔍 Проверяю подписки на каналы...\n')
    const results: Array<{ title: string; chatId: string; subscribed: boolean; error?: string }> = []

    for (const channel of channels) {
      try {
        // Преобразуем chatId в channel ID для API
        // chatId имеет формат "-1001234567890", нужно извлечь "1234567890"
        const channelIdStr = channel.chatId.replace(/^-100/, '')
        const channelId = BigInt(channelIdStr)

        console.log(`   Проверяю: ${channel.title} (${channel.chatId})...`)

        try {
          // Пытаемся получить entity канала
          const entity = await client.getEntity(new Api.PeerChannel({ channelId }))
          
          if (entity) {
            const channelTitle = (entity as any).title || 'не указано'
            // Проверяем, подписан ли аккаунт на канал
            // Если left === true, значит аккаунт покинул канал
            // Если left === false или undefined, значит аккаунт подписан
            const isSubscribed = (entity as any).left !== true
            
            results.push({
              title: channel.title,
              chatId: channel.chatId,
              subscribed: isSubscribed,
            })

            if (isSubscribed) {
              console.log(`      ✅ Подписан на канал "${channelTitle}"`)
            } else {
              console.log(`      ❌ НЕ подписан на канал "${channelTitle}" (left: true)`)
            }
          } else {
            results.push({
              title: channel.title,
              chatId: channel.chatId,
              subscribed: false,
              error: 'Не удалось получить entity канала',
            })
            console.log(`      ❌ Не удалось получить информацию о канале`)
          }
        } catch (error: any) {
          // Если канал не найден или аккаунт не подписан
          const errorMessage = error.message || error.errorMessage || 'Неизвестная ошибка'
          const errorCode = error.code || error.errorCode
          
          if (errorCode === 400 || 
              errorMessage.includes('CHANNEL_PRIVATE') || 
              errorMessage.includes('CHANNEL_INVALID') ||
              errorMessage.includes('not found') ||
              errorMessage.includes('USER_NOT_PARTICIPANT')) {
            results.push({
              title: channel.title,
              chatId: channel.chatId,
              subscribed: false,
              error: 'Канал не найден или аккаунт не подписан',
            })
            console.log(`      ❌ Канал не найден или аккаунт не подписан`)
            console.log(`         Ошибка: ${errorMessage}`)
          } else {
            results.push({
              title: channel.title,
              chatId: channel.chatId,
              subscribed: false,
              error: errorMessage,
            })
            console.log(`      ❌ Ошибка: ${errorMessage}`)
          }
        }
      } catch (error: any) {
        results.push({
          title: channel.title,
          chatId: channel.chatId,
          subscribed: false,
          error: error.message || 'Ошибка при проверке',
        })
        console.log(`      ❌ Ошибка: ${error.message || 'неизвестная ошибка'}`)
      }
    }

    console.log('\n═══════════════════════════════════════════════════════════')
    console.log('📊 РЕЗУЛЬТАТЫ ПРОВЕРКИ:')
    console.log('═══════════════════════════════════════════════════════════\n')

    const subscribed = results.filter(r => r.subscribed)
    const notSubscribed = results.filter(r => !r.subscribed)

    console.log(`✅ Подписан на ${subscribed.length} каналов:`)
    subscribed.forEach(r => {
      console.log(`   - ${r.title} (${r.chatId})`)
    })

    if (notSubscribed.length > 0) {
      console.log(`\n❌ НЕ подписан на ${notSubscribed.length} каналов:`)
      notSubscribed.forEach(r => {
        console.log(`   - ${r.title} (${r.chatId})`)
        if (r.error) {
          console.log(`     Ошибка: ${r.error}`)
        }
      })
    }

    console.log('\n💡 РЕКОМЕНДАЦИИ:')
    if (notSubscribed.length > 0) {
      console.log('   1. Подпишитесь на каналы через Telegram аккаунт:')
      notSubscribed.forEach(r => {
        console.log(`      - Откройте канал "${r.title}" в Telegram`)
        console.log(`      - Нажмите "Подписаться"`)
      })
      console.log('')
      console.log('   2. После подписки перезапустите Worker:')
      console.log('      curl -X POST https://chatbot-tg.onrender.com/runner/stop')
      console.log('      curl -X POST https://chatbot-tg.onrender.com/runner/start')
    } else {
      console.log('   ✅ Аккаунт подписан на все каналы!')
      console.log('   💡 Если сообщения все еще не приходят, проверьте:')
      console.log('      1. Запущен ли Worker')
      console.log('      2. Правильно ли настроен MAIN_APP_URL')
      console.log('      3. Логи Worker на Render.com')
    }

  } catch (error: any) {
    console.error('❌ Ошибка при проверке подписок:')
    console.error(`   ${error.message}`)
    if (error.message?.includes('AUTH_KEY_DUPLICATED')) {
      console.error('\n   ⚠️ ОШИБКА: AUTH_KEY_DUPLICATED')
      console.error('   Сессия используется одновременно в нескольких местах!')
      console.error('   Остановите локальный Worker или другие инстансы')
    }
  } finally {
    await client.disconnect()
    await prisma.$disconnect()
  }
}

checkChannelSubscriptions()

