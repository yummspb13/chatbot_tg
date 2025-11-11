import { NextRequest, NextResponse } from 'next/server'
import { getBot } from '@/lib/telegram/bot'

/**
 * Debug endpoint для проверки настроек админа
 * GET /api/debug/admin-check
 */
export async function GET(req: NextRequest) {
  const adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID
  
  return NextResponse.json({
    adminChatId: adminChatId || 'НЕ УСТАНОВЛЕН',
    adminChatIdType: typeof adminChatId,
    adminChatIdLength: adminChatId?.length || 0,
    adminChatIdTrimmed: adminChatId?.trim() || 'НЕ УСТАНОВЛЕН',
    allTelegramEnvVars: Object.keys(process.env)
      .filter(k => k.includes('TELEGRAM') || k.includes('ADMIN'))
      .reduce((acc, key) => {
        acc[key] = process.env[key] ? `${process.env[key]?.substring(0, 10)}...` : 'не установлен'
        return acc
      }, {} as Record<string, string>),
    timestamp: new Date().toISOString(),
  })
}

