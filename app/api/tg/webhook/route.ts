import { NextRequest, NextResponse } from 'next/server'
import { getBot } from '@/lib/telegram/bot'
// Импортируем для регистрации обработчиков
import '@/lib/telegram/webhook-handlers'

export async function POST(req: NextRequest) {
  try {
    const update = await req.json()

    const bot = getBot()

    // Используем handleUpdate для обработки обновления
    // Telegraf автоматически вызовет нужные обработчики
    await bot.handleUpdate(update)

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('Error processing webhook:', error)
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

