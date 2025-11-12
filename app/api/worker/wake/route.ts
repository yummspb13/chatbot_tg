/**
 * API endpoint для пробуждения Worker
 * Можно вызывать вручную или через cron сервис
 */

import { NextRequest, NextResponse } from 'next/server'
import { wakeWorkerIfNeeded } from '@/lib/worker/wake-worker'

export async function GET(req: NextRequest) {
  try {
    console.log('[worker/wake] Запрос на пробуждение Worker...')
    
    const result = await wakeWorkerIfNeeded()
    
    if (result) {
      return NextResponse.json({
        success: true,
        message: 'Worker проверен и пробужден при необходимости',
        timestamp: new Date().toISOString(),
      })
    } else {
      return NextResponse.json({
        success: false,
        message: 'Не удалось пробудить Worker',
        timestamp: new Date().toISOString(),
      }, { status: 500 })
    }
  } catch (error: any) {
    console.error('[worker/wake] Ошибка:', error.message)
    return NextResponse.json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString(),
    }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  return GET(req)
}

