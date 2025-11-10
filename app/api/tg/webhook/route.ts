import { NextRequest, NextResponse } from 'next/server'
import { getBot } from '@/lib/telegram/bot'
import { handleStart, handleStop, handleStatus, handleAuto, handleManual, handleSetThreshold, handleAddCity, handleAddChannel, handleListChannels, handleRemoveChannel } from '@/lib/telegram/commands'
import { handleChannelMessage } from '@/lib/telegram/messageHandler'
import { handleCallback } from '@/lib/telegram/callbackHandler'

export async function POST(req: NextRequest) {
  try {
    const update = await req.json()

    const bot = getBot()

    // Обработка callback_query (кнопки)
    if (update.callback_query) {
      const ctx = bot.context(update)
      await handleCallback(ctx)
      return NextResponse.json({ ok: true })
    }

    // Обработка команд
    if (update.message && 'text' in update.message) {
      const text = update.message.text
      const ctx = bot.context(update)

      // Проверяем команды
      if (text.startsWith('/start')) {
        await handleStart(ctx)
        return NextResponse.json({ ok: true })
      }

      if (text.startsWith('/stop')) {
        await handleStop(ctx)
        return NextResponse.json({ ok: true })
      }

      if (text.startsWith('/status')) {
        await handleStatus(ctx)
        return NextResponse.json({ ok: true })
      }

      if (text.startsWith('/auto')) {
        await handleAuto(ctx)
        return NextResponse.json({ ok: true })
      }

      if (text.startsWith('/manual')) {
        await handleManual(ctx)
        return NextResponse.json({ ok: true })
      }

      if (text.startsWith('/setthreshold')) {
        await handleSetThreshold(ctx)
        return NextResponse.json({ ok: true })
      }

      if (text.startsWith('/addcity')) {
        await handleAddCity(ctx)
        return NextResponse.json({ ok: true })
      }

      if (text.startsWith('/addchannel')) {
        await handleAddChannel(ctx)
        return NextResponse.json({ ok: true })
      }

      if (text.startsWith('/listchannels')) {
        await handleListChannels(ctx)
        return NextResponse.json({ ok: true })
      }

      if (text.startsWith('/removechannel')) {
        await handleRemoveChannel(ctx)
        return NextResponse.json({ ok: true })
      }
    }

    // Обработка новых сообщений из каналов
    if (update.message && update.message.chat?.type === 'channel') {
      const ctx = bot.context(update)
      await handleChannelMessage(ctx)
      return NextResponse.json({ ok: true })
    }

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

