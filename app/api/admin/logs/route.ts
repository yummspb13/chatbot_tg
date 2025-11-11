import { NextRequest, NextResponse } from 'next/server'
import { verifySession } from '@/lib/auth/session'
import { cookies } from 'next/headers'
import { memoryLogger } from '@/lib/logging/memory-logger'

export async function GET(req: NextRequest) {
  // Проверка авторизации
  const cookieStore = await cookies()
  const token = cookieStore.get('admin-token')?.value

  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const session = await verifySession(token)
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Параметры запроса
  const searchParams = req.nextUrl.searchParams
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

export async function DELETE(req: NextRequest) {
  // Проверка авторизации
  const cookieStore = await cookies()
  const token = cookieStore.get('admin-token')?.value

  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const session = await verifySession(token)
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Очищаем логи
  memoryLogger.clear()

  return NextResponse.json({ success: true, message: 'Logs cleared' })
}

