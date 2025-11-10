import { NextRequest, NextResponse } from 'next/server'
import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions'
import { Api } from 'telegram/tl'
import qrcode from 'qrcode'
import { authSessions } from '../status/route'

// Стандартные credentials (не требуют создания приложения)
const DEFAULT_API_ID = 17349
const DEFAULT_API_HASH = '344583e45741c457fe1862106095a5eb'

export async function POST(req: NextRequest) {
  console.log('')
  console.log('═══════════════════════════════════════════════════════════')
  console.log('🔵 [QR-Auth] POST /api/admin/qr-auth/start')
  console.log('   Время:', new Date().toISOString())
  console.log('═══════════════════════════════════════════════════════════')
  try {
    console.log('   [QR-Auth] Начинаю создание QR-кода...')
    const apiId = process.env.TELEGRAM_API_ID ? parseInt(process.env.TELEGRAM_API_ID) : DEFAULT_API_ID
    const apiHash = process.env.TELEGRAM_API_HASH || DEFAULT_API_HASH

    console.log('   [QR-Auth] API ID:', apiId)
    console.log('   [QR-Auth] API Hash:', apiHash ? 'установлен' : 'не установлен')

    const session = new StringSession('')
    const client = new TelegramClient(session, apiId, apiHash, {
      connectionRetries: 5,
    })

    console.log('   [QR-Auth] Подключаюсь к Telegram...')
    await client.connect()
    console.log('   [QR-Auth] ✅ Подключено к Telegram')

    // Добавляем обработчик событий для отслеживания авторизации (как в Telegram Desktop)
    // Это позволяет получать уведомления когда QR-код отсканирован
    // Создаем временный токен для сохранения в сессии (будет заменен после получения QR-кода)
    let tempAuthToken: string | null = null

    client.addEventHandler(async (event: any) => {
      try {
        // Обрабатываем обновление о том, что QR-код отсканирован
        if (event instanceof Api.UpdateLoginToken) {
          console.log('')
          console.log('   ═══════════════════════════════════════════════════════════')
          console.log('   [QR-Auth] 📱 Получено обновление: QR-код отсканирован!')
          console.log('   [QR-Auth] Ищу сессию для этого клиента...')
          
          // Находим сессию по клиенту
          let sessionEntry: any = null
          let foundToken: string | null = null
          for (const [token, session] of authSessions.entries()) {
            if (session.client === client) {
              sessionEntry = session
              foundToken = token
              console.log('   [QR-Auth] ✅ Сессия найдена, токен:', token.substring(0, 20) + '...')
              break
            }
          }

          if (!sessionEntry) {
            console.log('   [QR-Auth] ⚠️ Сессия не найдена для обновления')
            console.log('   [QR-Auth] Всего сессий в Map:', authSessions.size)
            console.log('   ═══════════════════════════════════════════════════════════')
            console.log('')
            return
          }
          
          // После сканирования QR-кода, повторно вызываем ExportLoginToken
          // Теперь он должен вернуть LoginTokenSuccess
          console.log('   [QR-Auth] Повторно вызываю ExportLoginToken...')
          try {
            const result = await client.invoke(
              new Api.auth.ExportLoginToken({
                apiId,
                apiHash,
                exceptIds: [],
              })
            )

            console.log('   [QR-Auth] Результат ExportLoginToken:')
            console.log('      Тип:', result.constructor.name)
            console.log('      className:', (result as any).className)
            console.log('      instanceof LoginTokenSuccess:', result instanceof Api.auth.LoginTokenSuccess)
            console.log('      instanceof LoginTokenMigrateTo:', result instanceof Api.auth.LoginTokenMigrateTo)

            if (result instanceof Api.auth.LoginTokenSuccess) {
              console.log('   [QR-Auth] ✅ Авторизация успешна через обработчик событий!')
              const sessionString = client.session.save() as unknown as string
              
              // Обновляем сессию
              sessionEntry.authResolved = true
              sessionEntry.authSessionString = sessionString
              
              console.log('   [QR-Auth] Сессия обновлена, длина:', sessionString.length)
              console.log('   [QR-Auth] Первые 50 символов:', sessionString.substring(0, 50))
              console.log('   ═══════════════════════════════════════════════════════════')
              console.log('')
            } else if (result instanceof Api.auth.LoginTokenMigrateTo) {
              console.log('   [QR-Auth] 🔄 Требуется миграция на другой DC')
              console.log('   [QR-Auth] DC ID:', result.dcId)
              console.log('   [QR-Auth] Token:', result.token ? 'есть' : 'нет')
              console.log('   [QR-Auth] Token length:', result.token ? result.token.length : 0)
              
              // Нужно использовать ImportLoginToken на указанном DC
              // КРИТИЧНО: используем токен СРАЗУ, без переподключения!
              // Telegram Client API может автоматически обработать миграцию через ImportLoginToken
              try {
                // Сохраняем информацию о миграции в сессии
                sessionEntry.migrateToDcId = result.dcId
                sessionEntry.migrateToken = result.token
                
                // Пробуем использовать ImportLoginToken на ТЕКУЩЕМ клиенте
                // Telegram Client API должен автоматически перенаправить запрос на нужный DC
                console.log('   [QR-Auth] Вызываю ImportLoginToken (без переподключения, токен используется сразу)...')
                
                // Используем токен сразу, без переподключения
                // Telegram Client API обработает миграцию автоматически
                const migrateResult = await client.invoke(
                  new Api.auth.ImportLoginToken({
                    token: result.token,
                  })
                )
                
                console.log('   [QR-Auth] Результат ImportLoginToken после миграции:')
                console.log('      Тип:', migrateResult.constructor.name)
                console.log('      className:', (migrateResult as any).className)
                
                if (migrateResult instanceof Api.auth.LoginTokenSuccess) {
                  console.log('   [QR-Auth] ✅ Авторизация успешна после миграции!')
                  const sessionString = client.session.save() as unknown as string
                  
                  // Обновляем сессию
                  sessionEntry.authResolved = true
                  sessionEntry.authSessionString = sessionString
                  
                  console.log('   [QR-Auth] Сессия обновлена, длина:', sessionString.length)
                  console.log('   [QR-Auth] Первые 50 символов:', sessionString.substring(0, 50))
                  console.log('   ═══════════════════════════════════════════════════════════')
                  console.log('')
                } else if (migrateResult instanceof Api.auth.LoginTokenMigrateTo) {
                  // Возможна еще одна миграция - используем новый токен сразу
                  console.log('   [QR-Auth] ⚠️ Требуется еще одна миграция на DC:', migrateResult.dcId)
                  console.log('   [QR-Auth] Использую новый токен сразу (без переподключения)...')
                  
                  // Используем новый токен сразу, без переподключения
                  const nextMigrateResult = await client.invoke(
                    new Api.auth.ImportLoginToken({
                      token: migrateResult.token,
                    })
                  )
                  
                  if (nextMigrateResult instanceof Api.auth.LoginTokenSuccess) {
                    console.log('   [QR-Auth] ✅ Авторизация успешна после второй миграции!')
                    const sessionString = client.session.save() as unknown as string
                    sessionEntry.authResolved = true
                    sessionEntry.authSessionString = sessionString
                    
                    console.log('   [QR-Auth] Сессия обновлена, длина:', sessionString.length)
                    console.log('   ═══════════════════════════════════════════════════════════')
                    console.log('')
                  } else {
                    console.log('   [QR-Auth] ⚠️ После второй миграции все еще не LoginTokenSuccess')
                    console.log('   ═══════════════════════════════════════════════════════════')
                    console.log('')
                  }
                } else {
                  console.log('   [QR-Auth] ⚠️ После миграции все еще не LoginTokenSuccess')
                  console.log('   ═══════════════════════════════════════════════════════════')
                  console.log('')
                }
              } catch (migrateError: any) {
                console.log('   [QR-Auth] ❌ Ошибка при миграции:')
                console.log('      errorMessage:', migrateError.errorMessage)
                console.log('      errorCode:', migrateError.errorCode)
                console.log('      message:', migrateError.message)
                console.log('      className:', migrateError.className)
                
                // Если токен истек, пробуем переподключиться и использовать токен
                if (migrateError.errorMessage?.includes('AUTH_TOKEN_EXPIRED')) {
                  console.log('   [QR-Auth] ⚠️ Токен истек при первом вызове')
                  console.log('   [QR-Auth] Пробую переподключиться к DC и использовать токен...')
                  
                  try {
                    // Переподключаемся к нужному DC
                    if (client.connected) {
                      await client.disconnect()
                    }
                    await client.connect()
                    console.log('   [QR-Auth] ✅ Переподключился к DC:', result.dcId)
                    
                    // Пробуем использовать токен еще раз
                    const retryResult = await client.invoke(
                      new Api.auth.ImportLoginToken({
                        token: result.token,
                      })
                    )
                    
                    if (retryResult instanceof Api.auth.LoginTokenSuccess) {
                      console.log('   [QR-Auth] ✅ Авторизация успешна после повторной попытки!')
                      const sessionString = client.session.save() as unknown as string
                      sessionEntry.authResolved = true
                      sessionEntry.authSessionString = sessionString
                      console.log('   [QR-Auth] Сессия обновлена, длина:', sessionString.length)
                      console.log('   ═══════════════════════════════════════════════════════════')
                      console.log('')
                    } else {
                      console.log('   [QR-Auth] ⚠️ После повторной попытки все еще не LoginTokenSuccess')
                      console.log('   [QR-Auth] 💡 Попробуйте отсканировать QR-код снова (токен истек)')
                      console.log('   ═══════════════════════════════════════════════════════════')
                      console.log('')
                    }
                  } catch (retryError: any) {
                    console.log('   [QR-Auth] ❌ Ошибка при повторной попытке:', retryError.errorMessage)
                    console.log('   [QR-Auth] 💡 Попробуйте отсканировать QR-код снова')
                    console.log('   ═══════════════════════════════════════════════════════════')
                    console.log('')
                  }
                } else if (migrateError.errorMessage?.includes('PASSWORD') || migrateError.errorMessage?.includes('SESSION_PASSWORD_NEEDED')) {
                  console.log('   [QR-Auth] ⚠️ Требуется пароль 2FA (определено при миграции)')
                  sessionEntry.authPasswordRequired = true
                  console.log('   ═══════════════════════════════════════════════════════════')
                  console.log('')
                } else {
                  console.log('   ═══════════════════════════════════════════════════════════')
                  console.log('')
                }
              }
            } else {
              console.log('   [QR-Auth] ⚠️ Результат не LoginTokenSuccess, тип:', result.constructor.name)
              console.log('   ═══════════════════════════════════════════════════════════')
              console.log('')
            }
          } catch (error: any) {
            console.log('   [QR-Auth] ❌ Ошибка при повторном ExportLoginToken:')
            console.log('      errorMessage:', error.errorMessage)
            console.log('      errorCode:', error.errorCode)
            console.log('      message:', error.message)
            
            if (error.errorMessage?.includes('PASSWORD') || error.errorMessage?.includes('SESSION_PASSWORD_NEEDED')) {
              console.log('   [QR-Auth] ⚠️ Требуется пароль 2FA (определено через обработчик)')
              sessionEntry.authPasswordRequired = true
            }
            console.log('   ═══════════════════════════════════════════════════════════')
            console.log('')
          }
        }
      } catch (error) {
        console.error('   [QR-Auth] ❌ Ошибка в обработчике событий:', error)
        console.error('   [QR-Auth] Stack:', error instanceof Error ? error.stack : 'нет stack')
      }
    })

    // Запрашиваем QR-код для авторизации
    console.log('   [QR-Auth] Запрашиваю QR-код для авторизации...')
    const result = await client.invoke(
      new Api.auth.ExportLoginToken({
        apiId,
        apiHash,
        exceptIds: [],
      })
    )
    console.log('   [QR-Auth] Ответ получен, тип:', result.constructor.name)
    console.log('   [QR-Auth] className:', (result as any).className)
    console.log('   [QR-Auth] Проверка instanceof LoginToken:', result instanceof Api.auth.LoginToken)
    console.log('   [QR-Auth] Проверка instanceof LoginTokenSuccess:', result instanceof Api.auth.LoginTokenSuccess)

    if (result instanceof Api.auth.LoginToken) {
      // Создаем QR-код в официальном формате Telegram (tg://login?token=...)
      // Это тот же формат, что использует Telegram Desktop/Web
      const tokenBase64 = Buffer.from(result.token).toString('base64url') // base64url для URL
      const qrData = `tg://login?token=${tokenBase64}`
      
      // Генерируем QR-код
      const qrCodeBase64 = await qrcode.toDataURL(qrData, {
        errorCorrectionLevel: 'M',
        type: 'image/png',
        width: 300,
        margin: 2,
      })

      // Сохраняем клиент для проверки статуса (токен действителен 15 минут)
      const authToken = Buffer.from(result.token).toString('hex')
      authSessions.set(authToken, {
        client,
        expiresAt: Date.now() + 15 * 60 * 1000, // 15 минут
        authResolved: false,
        authSessionString: null,
        authPasswordRequired: false,
      })

      console.log('   [QR-Auth] ✅ QR-код создан успешно')
      console.log('   [QR-Auth] AuthToken:', authToken.substring(0, 20) + '...')
      console.log('═══════════════════════════════════════════════════════════')
      console.log('')
      
      return NextResponse.json({
        qrCode: qrCodeBase64,
        authToken,
        expiresIn: 15 * 60, // секунды
      })
    }

    if (result instanceof Api.auth.LoginTokenSuccess) {
      // Авторизация уже успешна
      const sessionString = client.session.save() as unknown as string
      return NextResponse.json({
        qrCode: null,
        sessionString,
        success: true,
      })
    }

    throw new Error('Неожиданный тип ответа')
  } catch (error: any) {
    console.error('')
    console.error('═══════════════════════════════════════════════════════════')
    console.error('❌ [QR-Auth] ОШИБКА при создании QR-кода')
    console.error('═══════════════════════════════════════════════════════════')
    console.error('   Сообщение:', error.message)
    console.error('   errorMessage:', error.errorMessage)
    console.error('   errorCode:', error.errorCode)
    console.error('   Stack:', error.stack)
    console.error('═══════════════════════════════════════════════════════════')
    console.error('')
    
    return NextResponse.json(
      { 
        error: error.message || error.errorMessage || 'Ошибка при создании QR-кода',
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined
      },
      { status: 500 }
    )
  }
}

