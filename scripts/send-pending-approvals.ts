#!/usr/bin/env tsx

/**
 * Скрипт для отправки карточек одобрения для существующих PENDING черновиков
 * 
 * Использование:
 *   npm run send:pending-approvals
 */

import { config } from 'dotenv'
import { PrismaClient } from '@prisma/client'
import { getBot } from '../lib/telegram/bot'
import { predictDecision } from '../lib/openai/agent'

config()

const prisma = new PrismaClient()

async function formatDraftMessage(
  draft: any,
  channel: any,
  agentPrediction: { decision: string; confidence: number; reasoning: string }
): Promise<string> {
  // Используем функцию форматирования из messageHandler
  const { formatMoscowDate } = await import('../lib/utils/date')
  
  const cityName = draft.cityName || channel?.city?.name || 'Не указан'
  const venue = draft.venue || 'Не указано'
  const startDate = formatMoscowDate(draft.startDate)
  const endDate = draft.endDate ? formatMoscowDate(draft.endDate) : null
  const description = draft.description || 'Нет описания'

  const agentDecision = agentPrediction.decision === 'APPROVED' ? '✅ Принять' : '❌ Отклонить'
  const confidencePercent = Math.round(agentPrediction.confidence * 100)

  let message = `<b>🎭 Найдено новое мероприятие</b>\n\n`
  message += `<b>Город:</b> ${cityName}\n`
  message += `<b>Канал:</b> ${channel?.title || 'Неизвестен'}\n`
  message += `<b>Название:</b> ${draft.title}\n`
  message += `<b>Дата начала:</b> ${startDate}\n`
  if (endDate) {
    message += `<b>Дата окончания:</b> ${endDate}\n`
  }
  message += `<b>Место:</b> ${venue}\n`
  message += `<b>Описание:</b> ${description}\n`
  if (draft.sourceLink) {
    message += `\n<a href="${draft.sourceLink}">🔗 Ссылка на пост</a>\n`
  }

  message += `\n<b>🤖 Мнение агента:</b>\n`
  message += `${agentDecision} (уверенность: ${confidencePercent}%)\n`
  message += `<i>${agentPrediction.reasoning}</i>`

  return message
}

async function sendPendingApprovals() {
  console.log('🔍 Ищу черновики со статусом PENDING...\n')
  
  const drafts = await prisma.draftEvent.findMany({
    where: { status: 'PENDING' },
    include: {
      channel: true,
      city: true,
    },
    orderBy: { createdAt: 'asc' },
  })
  
  if (drafts.length === 0) {
    console.log('✅ Нет черновиков со статусом PENDING')
    await prisma.$disconnect()
    return
  }
  
  console.log(`📋 Найдено ${drafts.length} черновиков для отправки\n`)
  
  const approvalChatId = process.env.TELEGRAM_PUBLISH_GROUP_ID || process.env.TELEGRAM_ADMIN_CHAT_ID
  
  if (!approvalChatId) {
    console.error('❌ TELEGRAM_PUBLISH_GROUP_ID и TELEGRAM_ADMIN_CHAT_ID не установлены')
    await prisma.$disconnect()
    return
  }
  
  console.log(`📤 Отправляю карточки в группу: ${approvalChatId}\n`)
  
  const bot = getBot()
  let successCount = 0
  let errorCount = 0
  
  for (const draft of drafts) {
    try {
      console.log(`📝 Обрабатываю черновик ID: ${draft.id} - "${draft.title.substring(0, 50)}..."`)
      
      // Получаем предсказание агента (или создаем новое)
      const lastDecision = await prisma.learningDecision.findFirst({
        where: {
          telegramMessageId: draft.telegramMessageId,
          telegramChatId: draft.telegramChatId,
        },
        orderBy: { createdAt: 'desc' },
      })
      
      let agentPrediction: { decision: string; confidence: number; reasoning: string }
      
      if (lastDecision) {
        agentPrediction = {
          decision: lastDecision.agentPrediction || 'APPROVED',
          confidence: lastDecision.agentConfidence || 0.8,
          reasoning: lastDecision.agentReasoning || 'Решение на основе истории',
        }
      } else {
        // Создаем новое предсказание
        const extractedFields = {
          title: draft.title,
          startDateIso: draft.startDate.toISOString(),
          endDateIso: draft.endDate?.toISOString() || null,
          venue: draft.venue,
          cityName: draft.cityName,
          description: draft.description,
        }
        
        agentPrediction = await predictDecision(
          draft.description || draft.title,
          extractedFields
        )
      }
      
      // Формируем сообщение
      const messageText = await formatDraftMessage(draft, draft.channel, agentPrediction)
      
      // Формируем клавиатуру
      const keyboard = {
        inline_keyboard: [
          [
            { text: '✅ Принять', callback_data: `approve:${draft.id}` },
            { text: '❌ Отказать', callback_data: `reject:${draft.id}` },
          ],
        ],
      }
      
      // Отправляем карточку
      await bot.telegram.sendMessage(approvalChatId, messageText, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      })
      
      console.log(`   ✅ Карточка отправлена для черновика ID: ${draft.id}\n`)
      successCount++
      
      // Небольшая задержка между отправками
      await new Promise(resolve => setTimeout(resolve, 500))
      
    } catch (error: any) {
      console.error(`   ❌ Ошибка при отправке карточки для черновика ID: ${draft.id}`)
      console.error(`      ${error.message}`)
      errorCount++
    }
  }
  
  console.log('\n📊 ИТОГИ:')
  console.log(`   ✅ Успешно отправлено: ${successCount}`)
  console.log(`   ❌ Ошибок: ${errorCount}`)
  
  await prisma.$disconnect()
}

sendPendingApprovals().catch(console.error)

