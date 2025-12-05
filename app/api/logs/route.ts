import { NextRequest, NextResponse } from 'next/server'
import { memoryLogger } from '@/lib/logging/memory-logger'

/**
 * Публичный endpoint для просмотра логов с защитой по API ключу
 * GET /api/logs?key=YOUR_API_KEY
 */
export async function GET(req: NextRequest) {
  // Проверка API ключа из query параметра или заголовка
  const searchParams = req.nextUrl.searchParams
  const apiKey = searchParams.get('key') || req.headers.get('X-API-Key')
  const expectedKey = process.env.BOT_API_KEY || process.env.ADMIN_API_KEY

  if (expectedKey && apiKey !== expectedKey) {
    return NextResponse.json(
      { error: 'Unauthorized. Provide ?key=YOUR_API_KEY or X-API-Key header' },
      { status: 401 }
    )
  }

  // Параметры запроса
  const limit = parseInt(searchParams.get('limit') || '100')
  const source = searchParams.get('source') || undefined
  const stats = searchParams.get('stats') === 'true'

  // Получаем логи
  const logs = memoryLogger.getLogs(limit, source)
  const response: any = { logs }

  if (stats) {
    response.stats = memoryLogger.getStats()
  }

  return NextResponse.json(response)
}
