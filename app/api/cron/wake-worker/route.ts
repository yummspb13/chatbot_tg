import { NextRequest, NextResponse } from 'next/server'
import { wakeWorkerIfNeeded } from '@/lib/worker/wake-worker'

/**
 * Cron endpoint для автоматического пробуждения Worker
 * Вызывается периодически (каждые 5-10 минут) для предотвращения idle timeout
 * 
 * Можно использовать:
 * 1. Vercel Cron Jobs (если доступны)
 * 2. Внешний сервис cron-job.org
 * 3. Другие cron сервисы
 */
export async function GET(req: NextRequest) {
  const logPrefix = `[${new Date().toISOString()}]`
  
  // Проверяем, что это запрос от cron (опционально - можно добавить проверку заголовков)
  const authHeader = req.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET
  
  // Если установлен CRON_SECRET, проверяем его
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    // Для cron-job.org и других сервисов можно пропустить проверку
    // или использовать другой метод аутентификации
    console.warn(`${logPrefix} ⚠️ Неавторизованный запрос к cron endpoint`)
  }
  
  console.log(`${logPrefix} 🔔 [CRON] Запрос на пробуждение Worker...`)
  
  try {
    const result = await wakeWorkerIfNeeded()
    
    if (result) {
      console.log(`${logPrefix} ✅ [CRON] Worker пробужден или уже работает`)
      return NextResponse.json({
        success: true,
        message: 'Worker пробужден или уже работает',
        timestamp: new Date().toISOString(),
      })
    } else {
      console.warn(`${logPrefix} ⚠️ [CRON] Не удалось пробудить Worker`)
      return NextResponse.json({
        success: false,
        message: 'Не удалось пробудить Worker',
        timestamp: new Date().toISOString(),
      }, { status: 500 })
    }
  } catch (error: any) {
    console.error(`${logPrefix} ❌ [CRON] Ошибка пробуждения Worker:`, error.message)
    return NextResponse.json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString(),
    }, { status: 500 })
  }
}

// POST тоже поддерживается для совместимости
export async function POST(req: NextRequest) {
  return GET(req)
}


