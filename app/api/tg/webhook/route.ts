import { NextRequest, NextResponse } from 'next/server'
import { getBot } from '@/lib/telegram/bot'
// Импортируем для регистрации обработчиков
import '@/lib/telegram/webhook-handlers'

export async function POST(req: NextRequest) {
  const startTime = Date.now()
  try {
    const update = await req.json()
    
    // Логируем тип обновления для диагностики
    const updateType = update.message ? 'message' : 
                      update.channel_post ? 'channel_post' : 
                      update.callback_query ? 'callback_query' : 
                      'unknown'
    
    // Явное логирование с меткой времени для Vercel
    const logPrefix = `[${new Date().toISOString()}]`
    console.log(`${logPrefix} 📥 WEBHOOK: ${updateType}`)
    
    if (update.message) {
      const chatType = update.message.chat?.type || 'unknown'
      const chatId = update.message.chat?.id || 'unknown'
      const hasForward = !!update.message.forward_from_chat
      console.log(`${logPrefix} 📨 MESSAGE: chatType=${chatType} chatId=${chatId} hasForward=${hasForward}`)
      
      if (update.message.text) {
        const textPreview = update.message.text.substring(0, 100)
        console.log(`${logPrefix} 📨 TEXT: ${textPreview}`)
      }
    }
    
    if (update.channel_post) {
      console.log(`${logPrefix} 📢 CHANNEL_POST: chatId=${update.channel_post.chat?.id}`)
    }

    const bot = getBot()

    // Используем handleUpdate для обработки обновления
    // Telegraf автоматически вызовет нужные обработчики
    console.log(`${logPrefix} 🤖 Calling bot.handleUpdate...`)
    await bot.handleUpdate(update)
    
    const duration = Date.now() - startTime
    console.log(`${logPrefix} ✅ WEBHOOK: processed in ${duration}ms`)

    return NextResponse.json({ ok: true, processed: true, duration: `${duration}ms` })
  } catch (error) {
    const duration = Date.now() - startTime
    const logPrefix = `[${new Date().toISOString()}]`
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
  return NextResponse.json({ status: 'ok' })
}

