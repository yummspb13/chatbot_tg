/**
 * QR-код авторизация для Telegram Client API
 * Работает как вход в Telegram Desktop - через QR-код
 */

import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions'
import { Api } from 'telegram/tl'
import qrcode from 'qrcode'

// Стандартные credentials (не требуют создания приложения)
const DEFAULT_API_ID = 17349
const DEFAULT_API_HASH = '344583e45741c457fe1862106095a5eb'

let authClient: TelegramClient | null = null
let authSession: StringSession | null = null

/**
 * Начинает процесс авторизации через QR-код
 * Возвращает QR-код в виде base64 изображения
 */
export async function startQRAuth(): Promise<{
  qrCode: string // base64 изображение QR-кода
  authToken: string // токен для проверки статуса
}> {
  const apiId = process.env.TELEGRAM_API_ID ? parseInt(process.env.TELEGRAM_API_ID) : DEFAULT_API_ID
  const apiHash = process.env.TELEGRAM_API_HASH || DEFAULT_API_HASH

  authSession = new StringSession('')
  authClient = new TelegramClient(authSession, apiId, apiHash, {
    connectionRetries: 5,
  })

  await authClient.connect()

  // Запрашиваем QR-код для авторизации
  const result = await authClient.invoke(
    new Api.auth.ExportLoginToken({
      apiId,
      apiHash,
      exceptIds: [],
    })
  )

  if (result instanceof Api.auth.LoginToken) {
    // Генерируем QR-код
    const qrData = `tg://login?token=${Buffer.from(result.token).toString('base64')}`
    const qrCodeBase64 = await qrcode.toDataURL(qrData)

    return {
      qrCode: qrCodeBase64,
      authToken: Buffer.from(result.token).toString('hex'),
    }
  }

  throw new Error('Не удалось получить QR-код')
}

/**
 * Проверяет статус авторизации
 */
export async function checkAuthStatus(authToken: string): Promise<{
  status: 'pending' | 'success' | 'expired'
  sessionString?: string
}> {
  if (!authClient) {
    throw new Error('Авторизация не начата')
  }

  try {
    // Проверяем авторизацию
    const authorized = await authClient.checkAuthorization()
    
    if (authorized) {
      const sessionString = authClient.session.save() as unknown as string
      return {
        status: 'success',
        sessionString,
      }
    }

    return { status: 'pending' }
  } catch (error) {
    return { status: 'expired' }
  }
}

/**
 * Получает сохраненную сессию (если авторизация завершена)
 */
export async function getSessionString(): Promise<string | null> {
  if (!authClient) {
    return null
  }

  try {
    const authorized = await authClient.checkAuthorization()
    if (authorized) {
      return authClient.session.save() as unknown as string
    }
  } catch (error) {
    // Игнорируем ошибки
  }

  return null
}

/**
 * Останавливает процесс авторизации
 */
export async function stopQRAuth() {
  if (authClient) {
    await authClient.disconnect()
    authClient = null
    authSession = null
  }
}

