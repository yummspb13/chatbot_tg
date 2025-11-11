import { NextRequest, NextResponse } from 'next/server'
import { getBot } from '@/lib/telegram/bot'
// Импортируем для регистрации обработчиков
import '@/lib/telegram/webhook-handlers'

export async function POST(req: NextRequest) {
  const startTime = Date.now()
  const logPrefix = `[${new Date().toISOString()}]`
  
  try {
    const update = await req.json()
    
    // Логируем тип обновления для диагностики
    const updateType = update.message ? 'message' : 
                      update.channel_post ? 'channel_post' : 
                      update.callback_query ? 'callback_query' : 
                      'unknown'
    
    console.log(`${logPrefix} 📥 WEBHOOK RECEIVED: ${updateType}`)
    console.log(`${logPrefix} 📥 Full update:`, JSON.stringify(update, null, 2).substring(0, 1000))
    
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
  return NextResponse.json({ status: 'ok' })
}

