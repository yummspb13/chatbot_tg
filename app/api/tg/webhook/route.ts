import { NextRequest, NextResponse } from 'next/server'
import { getBot } from '@/lib/telegram/bot'
// Импортируем для регистрации обработчиков
import '@/lib/telegram/webhook-handlers'

export async function POST(req: NextRequest) {
  try {
    const update = await req.json()
    
    // Логируем тип обновления для диагностики
    const updateType = update.message ? 'message' : 
                      update.channel_post ? 'channel_post' : 
                      update.callback_query ? 'callback_query' : 
                      'unknown'
    console.log('📥 [WEBHOOK] Получено обновление:', updateType)
    
    if (update.message) {
      console.log('   📨 Тип сообщения:', update.message.chat?.type)
      console.log('   📨 Chat ID:', update.message.chat?.id)
      console.log('   📨 Есть forward_from_chat?', !!update.message.forward_from_chat)
      if (update.message.forward_from_chat) {
        console.log('   📨 Forward from chat ID:', update.message.forward_from_chat.id)
        console.log('   📨 Forward from chat type:', (update.message.forward_from_chat as any).type)
      }
    }
    
    if (update.channel_post) {
      console.log('   📢 Channel post, Chat ID:', update.channel_post.chat?.id)
    }

    const bot = getBot()

    // Используем handleUpdate для обработки обновления
    // Telegraf автоматически вызовет нужные обработчики
    await bot.handleUpdate(update)

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('❌ [WEBHOOK] Error processing webhook:', error)
    console.error('❌ [WEBHOOK] Stack trace:', error instanceof Error ? error.stack : 'нет stack trace')
    return NextResponse.json(
      { ok: false, error: 'Internal server error' },
      { status: 500 }
    )
  }
}

// Для проверки webhook от Telegram
export async function GET() {
  return NextResponse.json({ status: 'ok' })
}

