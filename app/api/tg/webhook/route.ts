import { NextRequest, NextResponse } from 'next/server'
import { getBot } from '@/lib/telegram/bot'
// Импортируем для регистрации обработчиков
import '@/lib/telegram/webhook-handlers'
import { getAIClient } from '@/lib/ai/provider'
import { memoryLogger } from '@/lib/logging/memory-logger'

// Принудительно делаем роут динамическим
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// Логируем конфигурацию при первом импорте
let configLogged = false
function logConfiguration() {
  if (!configLogged) {
    const aiClient = getAIClient()
    const provider = process.env.AI_PROVIDER || 'openai'
    const isProduction = process.env.NODE_ENV === 'production'
    
    console.log('🚀 Webhook endpoint initialized')
    console.log(`   Environment: ${isProduction ? 'PRODUCTION' : 'DEVELOPMENT'}`)
    console.log(`   AI Provider: ${provider.toUpperCase()} (${aiClient.provider})`)
    
    if (provider.toLowerCase() === 'mock' && isProduction) {
      console.error('   ⚠️  WARNING: Using MOCK AI provider in PRODUCTION!')
    }
    
    if (provider.toLowerCase() === 'openai' && !process.env.OPENAI_API_KEY) {
      console.error('   ⚠️  WARNING: OPENAI_API_KEY not set!')
    }
    
    configLogged = true
  }
}

export async function POST(req: NextRequest) {
  // Логируем конфигурацию при первом запросе
  logConfiguration()
  
  const startTime = Date.now()
  const logPrefix = `[${new Date().toISOString()}]`
  
  try {
    // Читаем body для проверки типа сообщения
    const bodyText = await req.text()
    const update = JSON.parse(bodyText)
    
    // Пробуждаем Worker если он уснул (только для сообщений из каналов)
    // Это помогает, если Worker уснул из-за idle timeout на Render.com
    const isChannelMessage = update.message?.chat?.type === 'channel' || 
                             update.channel_post ||
                             (update.message && update.message.forward_from_chat)
    
    if (isChannelMessage) {
      // Проверяем, включен ли Worker в настройках
      const { prisma } = await import('@/lib/db/prisma')
      const settings = await prisma.botSettings.findFirst()
      
      if (settings?.workerEnabled) {
        // Если это сообщение из канала, но Worker мог уснуть,
        // пробуждаем его асинхронно (не блокируем обработку)
        const { wakeWorkerIfNeeded } = await import('@/lib/worker/wake-worker')
        wakeWorkerIfNeeded().catch((error) => {
          console.warn(`${logPrefix} ⚠️ Не удалось пробудить Worker:`, error.message)
        })
      } else {
        console.log(`${logPrefix} ⏸ Worker отключен в настройках, пропускаю пробуждение`)
      }
    }
    
    // Создаем новый request с body для дальнейшей обработки
    req = new NextRequest(req.url, {
      method: req.method,
      headers: req.headers,
      body: bodyText,
    })
    
    // Логируем тип обновления для диагностики
    const updateType = update.message ? 'message' : 
                      update.channel_post ? 'channel_post' : 
                      update.callback_query ? 'callback_query' : 
                      'unknown'
    
    console.log(`${logPrefix} 📥 WEBHOOK RECEIVED: ${updateType}`)
    console.log(`${logPrefix} 📥 Full update:`, JSON.stringify(update, null, 2).substring(0, 1000))
    
    memoryLogger.info(
      `WEBHOOK RECEIVED: ${updateType}`,
      { updateType, update: JSON.stringify(update, null, 2).substring(0, 500) },
      'webhook'
    )
    
    if (update.message) {
      const chatType = update.message.chat?.type || 'unknown'
      const chatId = update.message.chat?.id || 'unknown'
      const userId = update.message.from?.id || 'unknown'
      const hasForward = !!update.message.forward_from_chat
      const text = update.message.text || ''
      console.log(`${logPrefix} 📨 MESSAGE:`)
      console.log(`${logPrefix}    chatType=${chatType}`)
      console.log(`${logPrefix}    chatId=${chatId}`)
      console.log(`${logPrefix}    userId=${userId}`)
      console.log(`${logPrefix}    text="${text}"`)
      console.log(`${logPrefix}    hasForward=${hasForward}`)
      console.log(`${logPrefix}    isCommand=${text.startsWith('/')}`)
      
      if (text.startsWith('/')) {
        console.log(`${logPrefix}    🎯 COMMAND DETECTED: ${text}`)
      }
    }
    
    if (update.channel_post) {
      console.log(`${logPrefix} 📢 CHANNEL_POST: chatId=${update.channel_post.chat?.id}`)
    }
    
    if (update.callback_query) {
      const callback = update.callback_query
      const userId = callback.from?.id || 'unknown'
      const chatId = callback.message?.chat?.id || 'unknown'
      const data = callback.data || 'no data'
      console.log(`${logPrefix} 🔘 CALLBACK_QUERY:`)
      console.log(`${logPrefix}    userId=${userId}`)
      console.log(`${logPrefix}    chatId=${chatId}`)
      console.log(`${logPrefix}    data="${data}"`)
      console.log(`${logPrefix}    messageId=${callback.message?.message_id || 'unknown'}`)
      
      memoryLogger.info(
        `CALLBACK_QUERY received`,
        { userId, chatId, data, messageId: callback.message?.message_id },
        'webhook'
      )
    }

    const bot = getBot()
    console.log(`${logPrefix} 🤖 Bot instance obtained, calling handleUpdate...`)

    // Используем handleUpdate для обработки обновления
    // Telegraf автоматически вызовет нужные обработчики
    await bot.handleUpdate(update)
    
    const duration = Date.now() - startTime
    console.log(`${logPrefix} ✅ WEBHOOK: processed in ${duration}ms`)

    return NextResponse.json({ ok: true, processed: true, duration: `${duration}ms` })
  } catch (error) {
    const duration = Date.now() - startTime
    console.error(`${logPrefix} ❌ WEBHOOK ERROR:`, error)
    console.error(`${logPrefix} ❌ STACK:`, error instanceof Error ? error.stack : 'нет stack trace')
    return NextResponse.json(
      { ok: false, error: 'Internal server error', duration: `${duration}ms` },
      { status: 500 }
    )
  }
}

// Для проверки webhook от Telegram
export async function GET() {
  logConfiguration()
  
  const aiClient = getAIClient()
  const provider = process.env.AI_PROVIDER || 'openai'
  
  return NextResponse.json({ 
    status: 'ok',
    environment: process.env.NODE_ENV || 'development',
    aiProvider: provider,
    aiProviderStatus: aiClient.provider,
    timestamp: new Date().toISOString(),
  })
}

