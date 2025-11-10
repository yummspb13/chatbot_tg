/**
 * QR-авторизация для Telegram Client API
 * Работает в воркере (постоянный процесс)
 */

import { Router } from 'express'
import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions'
import { Api } from 'telegram/tl'
import qrcode from 'qrcode'

const router = Router()

// Стандартные credentials (не требуют создания приложения)
const DEFAULT_API_ID = 17349
const DEFAULT_API_HASH = '344583e45741c457fe1862106095a5eb'

// Храним активные сессии авторизации (в продакшене использовать Redis)
const authSessions = new Map<string, {
  client: TelegramClient
  expiresAt: number
  authResolved?: boolean
  authSessionString?: string | null
  authPasswordRequired?: boolean
}>()

/**
 * POST /auth/qr/start
 * Начинает процесс QR-авторизации
 * Возвращает QR-код и authToken для проверки статуса
 */
router.post('/start', async (req, res) => {
  console.log('')
  console.log('═══════════════════════════════════════════════════════════')
  console.log('🔵 [Worker] POST /auth/qr/start')
  console.log('   Время:', new Date().toISOString())
  console.log('═══════════════════════════════════════════════════════════')
  
  try {
    const apiId = process.env.TELEGRAM_API_ID ? parseInt(process.env.TELEGRAM_API_ID) : DEFAULT_API_ID
    const apiHash = process.env.TELEGRAM_API_HASH || DEFAULT_API_HASH

    console.log('   [Worker] API ID:', apiId)
    console.log('   [Worker] API Hash:', apiHash ? 'установлен' : 'не установлен')

    const session = new StringSession('')
    const client = new TelegramClient(session, apiId, apiHash, {
      connectionRetries: 5,
    })

    console.log('   [Worker] Подключаюсь к Telegram...')
    await client.connect()
    console.log('   [Worker] ✅ Подключено к Telegram')

    // Добавляем обработчик событий для отслеживания авторизации
    client.addEventHandler(async (event: any) => {
      try {
        if (event instanceof Api.UpdateLoginToken) {
          console.log('   [Worker] 📱 Получено обновление: QR-код отсканирован!')
          
          // Находим сессию по клиенту (используем сохраненную ссылку или ищем)
          let sessionEntry: any = (client as any)._authSessionEntry || null
          
          if (!sessionEntry) {
            for (const [token, session] of authSessions.entries()) {
              if (session.client === client) {
                sessionEntry = session
                break
              }
            }
          }

          if (!sessionEntry) {
            console.log('   [Worker] ⚠️ Сессия не найдена для обновления')
            return
          }
          
          // После сканирования QR-кода, повторно вызываем ExportLoginToken
          try {
            const result = await client.invoke(
              new Api.auth.ExportLoginToken({
                apiId,
                apiHash,
                exceptIds: [],
              })
            )

            if (result instanceof Api.auth.LoginTokenSuccess) {
              console.log('   [Worker] ✅ Авторизация успешна через обработчик событий!')
              const sessionString = client.session.save() as unknown as string
              sessionEntry.authResolved = true
              sessionEntry.authSessionString = sessionString
              console.log('   [Worker] Сессия обновлена, длина:', sessionString.length)
            } else if (result instanceof Api.auth.LoginToken) {
              // QR-код еще не отсканирован, продолжаем ждать
              console.log('   [Worker] ⏳ QR-код еще не отсканирован, продолжаем ждать...')
            } else if (result instanceof Api.auth.LoginTokenMigrateTo) {
              console.log('   [Worker] 🔄 Требуется миграция на DC:', result.dcId)
              
              // Используем ImportLoginToken на текущем клиенте (Telegram Client API обработает миграцию)
              try {
                const migrateResult = await client.invoke(
                  new Api.auth.ImportLoginToken({
                    token: result.token,
                  })
                )
                
                if (migrateResult instanceof Api.auth.LoginTokenSuccess) {
                  console.log('   [Worker] ✅ Авторизация успешна после миграции!')
                  const sessionString = client.session.save() as unknown as string
                  sessionEntry.authResolved = true
                  sessionEntry.authSessionString = sessionString
                  console.log('   [Worker] Сессия сохранена после миграции, длина:', sessionString.length)
                } else {
                  console.log('   [Worker] ⚠️ После миграции получен неожиданный результат:', migrateResult.constructor.name)
                  // Пробуем проверить через getMe, возможно требуется пароль
                  try {
                    await client.getMe()
                  } catch (getMeError: any) {
                    if (getMeError.errorMessage?.includes('PASSWORD') || 
                        getMeError.errorMessage?.includes('SESSION_PASSWORD_NEEDED')) {
                      console.log('   [Worker] ⚠️ Требуется пароль 2FA (определено через getMe после миграции)')
                      sessionEntry.authPasswordRequired = true
                    }
                  }
                }
              } catch (migrateError: any) {
                console.log('   [Worker] ❌ Ошибка при миграции:', migrateError.errorMessage || migrateError.message)
                if (migrateError.errorMessage?.includes('PASSWORD') || 
                    migrateError.errorMessage?.includes('SESSION_PASSWORD_NEEDED') ||
                    migrateError.message?.includes('PASSWORD')) {
                  console.log('   [Worker] ⚠️ Требуется пароль 2FA после миграции')
                  sessionEntry.authPasswordRequired = true
                } else {
                  // Если другая ошибка, пробуем проверить через getMe
                  try {
                    await client.getMe()
                  } catch (getMeError: any) {
                    if (getMeError.errorMessage?.includes('PASSWORD') || 
                        getMeError.errorMessage?.includes('SESSION_PASSWORD_NEEDED')) {
                      console.log('   [Worker] ⚠️ Требуется пароль 2FA (определено через getMe)')
                      sessionEntry.authPasswordRequired = true
                    }
                  }
                }
              }
            }
          } catch (error: any) {
            if (error.errorMessage?.includes('PASSWORD') || error.errorMessage?.includes('SESSION_PASSWORD_NEEDED')) {
              console.log('   [Worker] ⚠️ Требуется пароль 2FA')
              sessionEntry.authPasswordRequired = true
            }
          }
        }
      } catch (error) {
        console.error('   [Worker] Ошибка в обработчике событий:', error)
      }
    })

    // Запрашиваем QR-код для авторизации
    console.log('   [Worker] Запрашиваю QR-код для авторизации...')
    const result = await client.invoke(
      new Api.auth.ExportLoginToken({
        apiId,
        apiHash,
        exceptIds: [],
      })
    )

    if (result instanceof Api.auth.LoginToken) {
      // Создаем QR-код
      const tokenBase64 = Buffer.from(result.token).toString('base64url')
      const qrData = `tg://login?token=${tokenBase64}`
      
      const qrCodeBase64 = await qrcode.toDataURL(qrData, {
        errorCorrectionLevel: 'M',
        type: 'image/png',
        width: 300,
        margin: 2,
      })

      // Сохраняем клиент для проверки статуса
      const authToken = Buffer.from(result.token).toString('hex')
      authSessions.set(authToken, {
        client,
        expiresAt: Date.now() + 15 * 60 * 1000, // 15 минут
        authResolved: false,
        authSessionString: null,
        authPasswordRequired: false,
      })

      console.log('   [Worker] ✅ QR-код создан успешно')
      console.log('   [Worker] AuthToken:', authToken.substring(0, 20) + '...')
      console.log('═══════════════════════════════════════════════════════════')
      console.log('')
      
      return res.json({
        qrCode: qrCodeBase64,
        authToken,
        expiresIn: 15 * 60, // секунды
      })
    }

    if (result instanceof Api.auth.LoginTokenSuccess) {
      // Уже авторизован
      const sessionString = client.session.save() as unknown as string
      return res.json({
        qrCode: null,
        sessionString,
        success: true,
      })
    }

    throw new Error('Неожиданный тип ответа')
  } catch (error: any) {
    console.error('')
    console.error('═══════════════════════════════════════════════════════════')
    console.error('❌ [Worker] ОШИБКА при создании QR-кода')
    console.error('═══════════════════════════════════════════════════════════')
    console.error('   Сообщение:', error.message)
    console.error('   errorMessage:', error.errorMessage)
    console.error('   errorCode:', error.errorCode)
    console.error('═══════════════════════════════════════════════════════════')
    console.error('')
    
    return res.status(500).json({
      error: error.message || error.errorMessage || 'Ошибка при создании QR-кода',
    })
  }
})

/**
 * POST /auth/qr/status
 * Проверяет статус QR-авторизации
 */
router.post('/status', async (req, res) => {
  try {
    const { authToken } = req.body

    if (!authToken) {
      return res.status(400).json({ error: 'authToken не предоставлен' })
    }

    const sessionData = authSessions.get(authToken)
    if (!sessionData) {
      return res.json({ status: 'expired' })
    }

    if (Date.now() > sessionData.expiresAt) {
      authSessions.delete(authToken)
      return res.json({ status: 'expired' })
    }

    const { client } = sessionData

    // Проверяем, не получили ли мы авторизацию через обработчик событий
    if (sessionData.authResolved && sessionData.authSessionString) {
      console.log('   [Worker] ✅ Авторизация получена через обработчик событий!')
      authSessions.delete(authToken)
      
      try {
        await client.disconnect()
      } catch (e) {
        // Игнорируем ошибки отключения
      }
      
      return res.json({
        status: 'success',
        sessionString: sessionData.authSessionString,
      })
    }

    // Проверяем, требуется ли пароль
    if (sessionData.authPasswordRequired) {
      return res.json({
        status: 'password_required',
        hint: 'Требуется пароль двухфакторной аутентификации',
      })
    }

    // Пробуем получить информацию о пользователе
    try {
      const me = await client.getMe()
      if (me) {
        console.log('   [Worker] ✅ getMe() успешен, пользователь авторизован:', me.id)
        const sessionString = client.session.save() as unknown as string
        authSessions.delete(authToken)
        
        try {
          await client.disconnect()
        } catch (e) {
          // Игнорируем ошибки отключения
        }
        
        return res.json({
          status: 'success',
          sessionString,
        })
      }
    } catch (getMeError: any) {
      if (getMeError.errorMessage?.includes('PASSWORD') || getMeError.errorMessage?.includes('SESSION_PASSWORD_NEEDED')) {
        sessionData.authPasswordRequired = true
        return res.json({
          status: 'password_required',
          hint: getMeError.hint || 'Требуется пароль двухфакторной аутентификации',
        })
      }
    }

    // Пробуем повторно вызвать ExportLoginToken
    try {
      const apiId = process.env.TELEGRAM_API_ID ? parseInt(process.env.TELEGRAM_API_ID) : DEFAULT_API_ID
      const apiHash = process.env.TELEGRAM_API_HASH || DEFAULT_API_HASH
      
      const exportResult = await client.invoke(
        new Api.auth.ExportLoginToken({
          apiId,
          apiHash,
          exceptIds: [],
        })
      )

      if (exportResult instanceof Api.auth.LoginTokenSuccess) {
        console.log('   [Worker] ✅ Авторизация успешна через повторный ExportLoginToken!')
        const sessionString = client.session.save() as unknown as string
        authSessions.delete(authToken)
        
        try {
          await client.disconnect()
        } catch (e) {
          // Игнорируем ошибки отключения
        }
        
        return res.json({
          status: 'success',
          sessionString,
        })
      }
    } catch (exportError: any) {
      if (exportError.errorMessage?.includes('PASSWORD') || exportError.errorMessage?.includes('SESSION_PASSWORD_NEEDED')) {
        sessionData.authPasswordRequired = true
        return res.json({
          status: 'password_required',
          hint: exportError.hint || 'Требуется пароль двухфакторной аутентификации',
        })
      }
    }

    return res.json({ status: 'pending' })
  } catch (error: any) {
    console.error('Ошибка проверки статуса:', error)
    return res.status(500).json({
      error: error.message || 'Ошибка проверки статуса',
    })
  }
})

/**
 * POST /auth/qr/password
 * Обрабатывает ввод пароля 2FA
 */
router.post('/password', async (req, res) => {
  try {
    const { authToken, password } = req.body

    if (!authToken || !password) {
      return res.status(400).json({ error: 'authToken и password обязательны' })
    }

    const sessionData = authSessions.get(authToken)
    if (!sessionData) {
      return res.status(400).json({ error: 'Сессия не найдена или истекла' })
    }

    const { client } = sessionData

    try {
      const { computeCheck } = await import('telegram/Password')
      
      // Получаем информацию о пароле
      const passwordInfo = await client.invoke(new Api.account.GetPassword())
      
      // Вычисляем хеш пароля
      const passwordCheck = await computeCheck(passwordInfo, password)
      
      // Проверяем пароль
      await client.invoke(
        new Api.auth.CheckPassword({
          password: passwordCheck,
        })
      )

      // Если успешно, сохраняем сессию
      const sessionString = client.session.save() as unknown as string
      authSessions.delete(authToken)
      
      try {
        await client.disconnect()
      } catch (e) {
        // Игнорируем ошибки отключения
      }

      console.log('✅ Авторизация с паролем успешна')
      return res.json({
        status: 'success',
        sessionString,
      })
    } catch (error: any) {
      console.error('   [Worker] ❌ Ошибка проверки пароля:', error)
      if (error.errorMessage?.includes('PASSWORD_HASH_INVALID')) {
        return res.status(400).json({ error: 'Неверный пароль' })
      }
      throw error
    }
  } catch (error: any) {
    console.error('Ошибка при проверке пароля:', error)
    return res.status(500).json({
      error: error.message || 'Ошибка при проверке пароля',
    })
  }
})

/**
 * POST /auth/qr/save
 * Сохраняет sessionString (вызывается из админ-панели)
 */
router.post('/save', async (req, res) => {
  try {
    const { sessionString } = req.body

    if (!sessionString) {
      return res.status(400).json({ error: 'sessionString не предоставлен' })
    }

    // В воркере мы просто сохраняем сессию в переменную окружения или БД
    // Для MVP сохраняем в .env (в продакшене - в зашифрованное хранилище)
    const fs = await import('fs/promises')
    const path = await import('path')
    
    const envPath = path.resolve(process.cwd(), '../.env')
    let envContent = ''

    try {
      envContent = await fs.readFile(envPath, 'utf-8')
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        throw error
      }
    }

    // Обновляем или добавляем TELEGRAM_SESSION_STRING
    if (envContent.includes('TELEGRAM_SESSION_STRING=')) {
      envContent = envContent.replace(
        /TELEGRAM_SESSION_STRING=.*/g,
        `TELEGRAM_SESSION_STRING="${sessionString}"`
      )
    } else {
      envContent += `\nTELEGRAM_SESSION_STRING="${sessionString}"\n`
    }

    await fs.writeFile(envPath, envContent, 'utf-8')
    console.log('✅ TELEGRAM_SESSION_STRING успешно сохранен в .env')

    return res.json({ success: true })
  } catch (error: any) {
    console.error('❌ Ошибка сохранения сессии:', error)
    return res.status(500).json({
      error: error.message || 'Ошибка сохранения сессии',
    })
  }
})

export { router as qrAuthRouter }

