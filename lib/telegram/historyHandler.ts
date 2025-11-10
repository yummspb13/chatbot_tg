import { getBot } from './bot'
import { prisma } from '@/lib/db/prisma'
import { handleChannelMessage } from './messageHandler'
import { Context } from 'telegraf'

/**
 * Обрабатывает последние N сообщений из каждого активного канала
 */
export async function handleHistory(historyDepth: number): Promise<{
  channelsProcessed: number
  draftsCreated: number
}> {
  const channels = await prisma.channel.findMany({
    where: { isActive: true },
    include: { city: true },
  })

  let channelsProcessed = 0
  let draftsCreated = 0

  const bot = getBot()

  for (const channel of channels) {
    try {
      // Получаем последние N сообщений из канала
      const updates = await getChannelHistory(bot, channel.chatId, historyDepth)

      for (const update of updates) {
        if (update.message) {
          // Создаем контекст для обработки сообщения
          const ctx = {
            ...update,
            chat: update.message.chat,
            message: update.message,
            from: update.message.from,
          } as any

          // Обрабатываем сообщение через тот же handler
          await handleChannelMessage(ctx as any)
          draftsCreated++
        }
      }

      channelsProcessed++
    } catch (error) {
      console.error(`Error processing history for channel ${channel.chatId}:`, error)
    }
  }

  return { channelsProcessed, draftsCreated }
}

/**
 * Получает историю сообщений из канала
 * Примечание: Telegram Bot API не предоставляет прямой метод для получения истории канала
 * Для этого нужно использовать Telegram Client API или хранить lastCheckedMessageId
 * 
 * Для MVP используем упрощенный подход: пытаемся получить сообщения через forwardMessage
 * или используем lastCheckedMessageId для отслеживания
 */
async function getChannelHistory(
  bot: any,
  chatId: string,
  limit: number
): Promise<any[]> {
  // Telegram Bot API ограничения:
  // - Бот должен быть администратором канала для получения истории
  // - Нет прямого метода для получения истории канала
  
  // Альтернативный подход: используем getUpdates, но это не работает для истории
  
  // Для MVP: возвращаем пустой массив и логируем
  // В продакшене нужно использовать Telegram Client API (MTProto) или
  // хранить lastCheckedMessageId и проверять новые сообщения
  
  console.log(`⚠️ Получение истории каналов не реализовано. Запрошено ${limit} сообщений из канала ${chatId}`)
  console.log(`   Telegram Bot API не позволяет получать историю каналов напрямую.`)
  console.log(`   Бот будет обрабатывать только новые сообщения.`)
  
  // Пока возвращаем пустой массив
  // TODO: Реализовать получение истории через Telegram Client API (MTProto)
  return []
}

