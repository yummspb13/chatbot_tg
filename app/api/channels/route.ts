/**
 * API для получения списка каналов
 * Используется worker'ом для мониторинга
 */

import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'

export async function GET(request: Request) {
  try {
    // Простая проверка авторизации (можно улучшить)
    const authHeader = request.headers.get('authorization')
    const expectedToken = process.env.BOT_API_KEY || process.env.WORKER_API_KEY
    
    if (expectedToken && authHeader !== `Bearer ${expectedToken}`) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    // Получаем все активные каналы
    const channels = await prisma.channel.findMany({
      where: {
        isActive: true,
      },
      select: {
        chatId: true,
        title: true,
      },
    })

    return NextResponse.json({
      channels: channels.map(ch => ({
        chatId: ch.chatId,
        title: ch.title,
      })),
    })
  } catch (error: any) {
    console.error('Ошибка получения каналов:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

