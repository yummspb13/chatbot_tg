import { Context } from 'telegraf'
import { prisma } from '@/lib/db/prisma'
import { isAdmin, getBotSettings, updateBotSettings, getBot } from './bot'
import { getLearningStats } from '@/lib/learning/decisionService'
import { handleHistory } from './historyHandler'
import { getMainKeyboard, removeKeyboard } from './keyboard'

/**
 * Возвращает клавиатуру только для личных чатов
 * По умолчанию клавиатура отключена
 */
function getKeyboardIfPrivate(ctx: Context) {
  // Клавиатура отключена по умолчанию
  return undefined
  // Если нужно включить обратно, раскомментируйте:
  // return ctx.chat?.type === 'private' ? getMainKeyboard() : undefined
}

/**
 * Обработчик команды /start
 * /start - запуск обработки новых сообщений
 * /start N - запуск + обработка последних N сообщений
 */
export async function handleStart(ctx: Context) {
  const logPrefix = `[${new Date().toISOString()}]`
  console.log(`${logPrefix} 🔵 handleStart вызван`)
  console.log(`${logPrefix}    User ID: ${ctx.from?.id} (type: ${typeof ctx.from?.id})`)
  console.log(`${logPrefix}    Chat ID: ${ctx.chat?.id} (type: ${typeof ctx.chat?.id})`)
  console.log(`${logPrefix}    Text: ${ctx.message && 'text' in ctx.message ? ctx.message.text : 'нет текста'}`)
  console.log(`${logPrefix}    TELEGRAM_ADMIN_CHAT_ID из env: ${process.env.TELEGRAM_ADMIN_CHAT_ID || 'НЕ УСТАНОВЛЕН'}`)
  
  const adminCheck = isAdmin(ctx)
  console.log(`${logPrefix}    isAdmin вернул: ${adminCheck}`)
  
  if (!adminCheck) {
    console.log(`${logPrefix}    ❌ Доступ запрещен (не админ)`)
    // Добавляем детальную информацию в ответ для диагностики
    const debugInfo = `\n\n🔍 Debug info:\nUser ID: ${ctx.from?.id}\nChat ID: ${ctx.chat?.id}\nExpected: ${process.env.TELEGRAM_ADMIN_CHAT_ID || 'НЕ УСТАНОВЛЕН'}`
    return ctx.reply('Доступ запрещен. Только администратор может использовать команды.' + debugInfo, getKeyboardIfPrivate(ctx))
  }

  console.log('   ✅ Админ подтвержден')
  const args = ctx.message && 'text' in ctx.message ? ctx.message.text.split(' ') : []
  const historyDepth = args[1] ? parseInt(args[1], 10) : 0
  console.log('   History depth:', historyDepth)

  if (isNaN(historyDepth) || historyDepth < 0) {
    return ctx.reply('Использование: /start [N]\nN - количество последних сообщений для обработки (0 = только новые)')
  }

  await updateBotSettings({ isRunning: true })

  let message = '✅ Бот запущен. Обработка новых сообщений включена.'

  if (historyDepth > 0) {
    message += `\n\n⏳ Обрабатываю последние ${historyDepth} сообщений из каждого активного канала...`
    await ctx.reply(message, getKeyboardIfPrivate(ctx))

    try {
      const result = await handleHistory(historyDepth)
      
      if (result.channelsProcessed === 0) {
        message = '✅ Бот запущен. Обработка новых сообщений включена.\n\n'
        message += '⚠️ Обработка истории сообщений пока не реализована.\n'
        message += 'Telegram Bot API не позволяет получать историю каналов напрямую.\n\n'
        message += 'Бот будет обрабатывать только НОВЫЕ сообщения из каналов.'
      } else {
        message += `\n\n✅ Обработано каналов: ${result.channelsProcessed}\n`
        message += `📝 Создано черновиков: ${result.draftsCreated}`
      }
    } catch (error) {
      console.error('Error processing history:', error)
      message = '✅ Бот запущен. Обработка новых сообщений включена.\n\n'
      message += '⚠️ Обработка истории сообщений пока не реализована.\n'
      message += 'Бот будет обрабатывать только НОВЫЕ сообщения из каналов.'
    }
  }

  return ctx.reply(message, getKeyboardIfPrivate(ctx))
}

/**
 * Обработчик команды /stop
 */
export async function handleStop(ctx: Context) {
  if (!isAdmin(ctx)) {
    return ctx.reply('Доступ запрещен.', getKeyboardIfPrivate(ctx))
  }

  await updateBotSettings({ isRunning: false })
  return ctx.reply('⏹ Бот остановлен. Обработка новых сообщений отключена.', getMainKeyboard())
}

/**
 * Обработчик команды /status
 */
export async function handleStatus(ctx: Context) {
  if (!isAdmin(ctx)) {
    return ctx.reply('Доступ запрещен.', getKeyboardIfPrivate(ctx))
  }

  const settings = await getBotSettings()
  const channels = await prisma.channel.count({ where: { isActive: true } })
  const stats = await getLearningStats()

  const modeText = settings.mode === 'AUTO' ? '🤖 Автоматический' : '👤 Ручной'
  const runningText = settings.isRunning ? '✅ Работает' : '⏹ Остановлен'

  return ctx.reply(
    `📊 Статус бота:\n\n` +
    `${runningText}\n` +
    `Режим: ${modeText}\n` +
    `Порог уверенности: ${settings.confidenceThreshold}\n` +
    `Активных каналов: ${channels}\n\n` +
    `📈 Статистика обучения:\n` +
    `Всего решений: ${stats.total}\n` +
    `Одобрено: ${stats.approved}\n` +
    `Отклонено: ${stats.rejected}\n` +
    `Точность агента: ${stats.accuracy}%`,
    getKeyboardIfPrivate(ctx)
  )
}

/**
 * Обработчик команды /auto
 */
export async function handleAuto(ctx: Context) {
  if (!isAdmin(ctx)) {
    return ctx.reply('Доступ запрещен.', getKeyboardIfPrivate(ctx))
  }

  await updateBotSettings({ mode: 'AUTO' })
  return ctx.reply('🤖 Режим переключен на автоматический. Бот будет самостоятельно принимать решения при высокой уверенности.', getMainKeyboard())
}

/**
 * Обработчик команды /manual
 */
export async function handleManual(ctx: Context) {
  if (!isAdmin(ctx)) {
    return ctx.reply('Доступ запрещен.', getKeyboardIfPrivate(ctx))
  }

  await updateBotSettings({ mode: 'MANUAL' })
  return ctx.reply('👤 Режим переключен на ручной. Все мероприятия будут отправляться на одобрение.', getMainKeyboard())
}

/**
 * Обработчик команды /setthreshold
 */
export async function handleSetThreshold(ctx: Context) {
  if (!isAdmin(ctx)) {
    return ctx.reply('Доступ запрещен.', getKeyboardIfPrivate(ctx))
  }

  const args = ctx.message && 'text' in ctx.message ? ctx.message.text.split(' ') : []
  const threshold = args[1] ? parseFloat(args[1]) : null

  if (threshold === null || isNaN(threshold) || threshold < 0 || threshold > 1) {
    return ctx.reply('Использование: /setthreshold <0.0-1.0>\nПример: /setthreshold 0.8')
  }

  await updateBotSettings({ confidenceThreshold: threshold })
  return ctx.reply(`✅ Порог уверенности установлен: ${threshold}`)
}

/**
 * Обработчик команды /addcity
 */
export async function handleAddCity(ctx: Context) {
  if (!isAdmin(ctx)) {
    return ctx.reply('Доступ запрещен.', getKeyboardIfPrivate(ctx))
  }

  const args = ctx.message && 'text' in ctx.message ? ctx.message.text.split(' ') : []
  const cityName = args.slice(1).join(' ')

  if (!cityName) {
    return ctx.reply('Использование: /addcity <название города>\nПример: /addcity Москва')
  }

  const slug = cityName
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-zа-я0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')

  try {
    const city = await prisma.city.create({
      data: {
        name: cityName,
        slug,
      },
    })

        return ctx.reply(`✅ Город добавлен:\nID: ${city.id}\nНазвание: ${city.name}\nSlug: ${city.slug}`, getMainKeyboard())
  } catch (error: any) {
    if (error.code === 'P2002') {
      return ctx.reply('❌ Город с таким названием или slug уже существует.')
    }
    console.error('Error adding city:', error)
    return ctx.reply('❌ Ошибка при добавлении города.')
  }
}

/**
 * Обработчик команды /addchannel
 * Автоматически определяет ID канала по ссылке или username
 */
export async function handleAddChannel(ctx: Context) {
  if (!isAdmin(ctx)) {
    return ctx.reply('Доступ запрещен.', getKeyboardIfPrivate(ctx))
  }

  const args = ctx.message && 'text' in ctx.message ? ctx.message.text.split(' ') : []
  const citySlug = args[1]
  const linkOrId = args[2]
  const channelTitle = args.slice(3).join(' ').trim()

  if (!citySlug || !linkOrId) {
    return ctx.reply(
      'Использование: /addchannel <slug города> <ссылка на канал или chat_id>\n\n' +
      'Примеры:\n' +
      '/addchannel sankt-peterburg https://t.me/deti_v_peterburge\n' +
      '/addchannel sankt-peterburg @deti_v_peterburge\n' +
      '/addchannel sankt-peterburg https://web.telegram.org/k/#@deti_v_peterburge\n' +
      '/addchannel sankt-peterburg -1001234567890'
    )
  }

  try {
    const city = await prisma.city.findUnique({ where: { slug: citySlug } })
    if (!city) {
      return ctx.reply(`❌ Город со slug "${citySlug}" не найден. Сначала добавьте город через /addcity.`)
    }

    // Извлекаем username или chat_id из ссылки
    let chatId: string
    let channelName: string = channelTitle

    // Проверяем, это ссылка/username или уже chat_id
    if (linkOrId.startsWith('http') || linkOrId.startsWith('@') || linkOrId.includes('telegram.org')) {
      // Это ссылка или username - нужно получить chat_id
      let username = linkOrId.trim()
      
      // Извлекаем username из разных форматов ссылок
      username = username.replace(/^https?:\/\//, '')
      username = username.replace(/^t\.me\//, '')
      username = username.replace(/^web\.telegram\.org\/k\/#/, '')
      username = username.replace(/^@/, '')
      username = username.split('#')[0].split('/')[0].split('?')[0]

      if (!username) {
        return ctx.reply('❌ Не удалось извлечь username из ссылки. Проверьте формат.')
      }

      // Получаем информацию о канале через Telegram API
      const bot = getBot()
      try {
        await ctx.reply(`🔍 Получаю информацию о канале @${username}...`, getMainKeyboard())
        const chat = await bot.telegram.getChat(`@${username}`)
        chatId = chat.id.toString()
        
        // Если название не указано, используем название канала
        if (!channelName) {
          // Проверяем, что это не приватный чат (у приватных чатов нет title)
          if ('title' in chat && chat.title) {
            channelName = chat.title
          } else {
            channelName = `Канал @${username}`
          }
        }
      } catch (error: any) {
        if (error.response?.error_code === 400) {
          return ctx.reply(
            '❌ Канал не найден или бот не добавлен в канал.\n\n' +
            '💡 Что делать:\n' +
            '1. Убедитесь, что канал существует\n' +
            '2. Добавьте бота в канал как администратора\n' +
            '3. Попробуйте снова'
          )
        } else if (error.response?.error_code === 403) {
          return ctx.reply(
            '❌ Бот не имеет доступа к каналу.\n\n' +
            '💡 Что делать:\n' +
            '1. Добавьте бота в канал\n' +
            '2. Сделайте бота администратором канала\n' +
            '3. Попробуйте снова'
          )
        }
        throw error
      }
    } else {
      // Это уже chat_id
      chatId = linkOrId
      if (!channelName) {
        channelName = `Канал ${chatId}`
      }
    }

    // Добавляем канал в базу
    const channel = await prisma.channel.upsert({
      where: { chatId: chatId },
      update: { cityId: city.id, title: channelName, isActive: true },
      create: { cityId: city.id, chatId: chatId, title: channelName, isActive: true },
    })
    
    return ctx.reply(
      `✅ Канал "${channel.title}" добавлен для города "${city.name}".\n\n` +
      `📋 Детали:\n` +
      `   Chat ID: ${channel.chatId}\n` +
      `   Город: ${city.name} (${city.slug})\n` +
      `   Статус: ${channel.isActive ? '✅ Активен' : '❌ Неактивен'}`,
      getKeyboardIfPrivate(ctx)
    )
  } catch (error: any) {
    console.error('Error adding channel:', error)
    if (error.code === 'P2002') {
      return ctx.reply('❌ Канал с таким Chat ID уже существует.')
    }
    return ctx.reply('❌ Ошибка при добавлении канала. Проверьте логи.')
  }
}

/**
 * Обработчик команды /listchannels
 */
export async function handleListChannels(ctx: Context) {
  if (!isAdmin(ctx)) {
    return ctx.reply('Доступ запрещен.', getKeyboardIfPrivate(ctx))
  }

  const cities = await prisma.city.findMany({
    include: {
      channels: {
        where: { isActive: true },
        orderBy: { title: 'asc' },
      },
    },
    orderBy: { name: 'asc' },
  })

  if (cities.length === 0) {
    return ctx.reply('📋 Городов и каналов пока нет.')
  }

  let message = '📋 Список городов и каналов:\n\n'

  for (const city of cities) {
    message += `🏙 ${city.name} (${city.slug})\n`
    
    if (city.channels.length === 0) {
      message += '  └─ Каналов нет\n\n'
    } else {
      for (const channel of city.channels) {
        const status = channel.isActive ? '✅' : '❌'
        message += `  ${status} [${channel.id}] ${channel.title}\n`
        message += `     Chat ID: ${channel.chatId}\n`
      }
      message += '\n'
    }
  }

  // Telegram ограничивает длину сообщения до 4096 символов
  if (message.length > 4000) {
    message = message.substring(0, 4000) + '\n... (сообщение обрезано)'
  }

  return ctx.reply(message)
}

/**
 * Обработчик команды /removechannel
 */
export async function handleRemoveChannel(ctx: Context) {
  if (!isAdmin(ctx)) {
    return ctx.reply('Доступ запрещен.', getKeyboardIfPrivate(ctx))
  }

  const args = ctx.message && 'text' in ctx.message ? ctx.message.text.split(' ') : []
  const channelId = args[1] ? parseInt(args[1], 10) : null

  if (channelId === null || isNaN(channelId)) {
    return ctx.reply('Использование: /removechannel <id>\nID можно узнать через /listchannels')
  }

  try {
    const channel = await prisma.channel.update({
      where: { id: channelId },
      data: { isActive: false },
    })

    return ctx.reply(`✅ Канал "${channel.title}" деактивирован.`)
  } catch (error) {
    console.error('Error removing channel:', error)
    return ctx.reply('❌ Канал не найден или ошибка при деактивации.')
  }
}

/**
 * Обработчик команды /export-training-data
 */
export async function handleExportTrainingData(ctx: Context) {
  if (!isAdmin(ctx)) {
    return ctx.reply('Доступ запрещен.', getKeyboardIfPrivate(ctx))
  }

  try {
    const { exportTrainingData } = await import('@/lib/learning/agentTraining')
    const data = await exportTrainingData()
    
    // Сохраняем во временный файл и отправляем
    // Для MVP просто показываем статистику
    const lines = data.split('\n').filter(Boolean)
    
    return ctx.reply(
      `📊 Данные для обучения подготовлены:\n` +
      `Строк данных: ${lines.length}\n\n` +
      `Для экспорта файла используйте API endpoint или добавьте функционал сохранения файла.`
    )
  } catch (error) {
    console.error('Error exporting training data:', error)
    return ctx.reply('❌ Ошибка при экспорте данных.')
  }
}

