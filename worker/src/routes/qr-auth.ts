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
  migrateToDcId?: number
  migrateToken?: Buffer
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

    // ВАЖНО: Очищаем старые обработчики перед добавлением нового
    // Это предотвращает накопление обработчиков и ложные срабатывания
    try {
      if ((client as any)._eventBuilders) {
        (client as any)._eventBuilders = []
        console.log('   [Worker] 🧹 Очищены старые обработчики событий')
      }
    } catch (e) {
      // Игнорируем ошибки при очистке
    }
    
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
          // ВАЖНО: Делаем это сразу, пока токен не истек
          try {
            console.log('   [Worker] 🔄 Повторно вызываю ExportLoginToken после сканирования QR...')
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
              console.log('   [Worker] Выполняю ImportLoginToken для миграции (сразу, пока токен не истек)...')
              
              // Сохраняем токен миграции для использования с паролем
              sessionEntry.migrateToDcId = result.dcId
              sessionEntry.migrateToken = result.token
              
              // ВАЖНО: Импортируем токен сразу, не дожидаясь истечения
              // Используем ImportLoginToken на текущем клиенте (Telegram Client API обработает миграцию)
              try {
                console.log('   [Worker] ⚡ Импортирую токен миграции немедленно...')
                const migrateResult = await client.invoke(
                  new Api.auth.ImportLoginToken({
                    token: result.token,
                  })
                )
                
                console.log('   [Worker] Результат миграции:', migrateResult.constructor.name)
                
                if (migrateResult instanceof Api.auth.LoginTokenSuccess) {
                  console.log('   [Worker] ✅ Авторизация успешна после миграции!')
                  const sessionString = client.session.save() as unknown as string
                  sessionEntry.authResolved = true
                  sessionEntry.authSessionString = sessionString
                  console.log('   [Worker] Сессия сохранена после миграции, длина:', sessionString.length)
                } else {
                  console.log('   [Worker] ⚠️ После миграции получен неожиданный результат:', migrateResult.constructor.name)
                  // Пробуем проверить через getMe, возможно требуется пароль
                  console.log('   [Worker] Проверяю через getMe()...')
                  try {
                    const me = await client.getMe()
                    console.log('   [Worker] ✅ getMe() успешен, пользователь авторизован:', me.id)
                    // Если getMe успешен, значит авторизация прошла
                    const sessionString = client.session.save() as unknown as string
                    sessionEntry.authResolved = true
                    sessionEntry.authSessionString = sessionString
                  } catch (getMeError: any) {
                    console.log('   [Worker] ❌ getMe() ошибка:', getMeError.errorMessage || getMeError.message)
                    // ВАЖНО: Проверяем, действительно ли требуется пароль
                    // Если 2FA отключена, не устанавливаем флаг пароля
                    if (getMeError.errorMessage?.includes('PASSWORD') || 
                        getMeError.errorMessage?.includes('SESSION_PASSWORD_NEEDED')) {
                      // Проверяем, действительно ли включена 2FA
                      try {
                        const passwordInfo = await client.invoke(new Api.account.GetPassword())
                        if (passwordInfo && passwordInfo.hasPassword) {
                          console.log('   [Worker] ⚠️ Требуется пароль 2FA (2FA включена)')
                          sessionEntry.authPasswordRequired = true
                        } else {
                          console.log('   [Worker] ✅ 2FA отключена, пароль не требуется')
                          // Не устанавливаем флаг пароля, продолжаем попытки авторизации
                        }
                      } catch (checkPasswordError: any) {
                        // Если не удалось проверить, не устанавливаем флаг пароля
                        console.log('   [Worker] ⚠️ Не удалось проверить статус 2FA, продолжаю без пароля')
                      }
                    }
                    // Если другая ошибка (не связанная с паролем), не устанавливаем флаг пароля
                  }
                }
              } catch (migrateError: any) {
                console.log('   [Worker] ❌ Ошибка при миграции:', migrateError.errorMessage || migrateError.message)
                
                // Если токен истек, пробуем проверить через getMe - возможно сессия уже зарегистрирована
                if (migrateError.errorMessage?.includes('AUTH_TOKEN_EXPIRED') ||
                    migrateError.errorMessage?.includes('TOKEN_EXPIRED')) {
                  console.log('   [Worker] ⚠️ Токен миграции истек, проверяю через getMe()...')
                  try {
                    const me = await client.getMe()
                    console.log('   [Worker] ✅ getMe() успешен после истечения токена:', me.id)
                    // Если getMe успешен, значит авторизация прошла
                    const sessionString = client.session.save() as unknown as string
                    sessionEntry.authResolved = true
                    sessionEntry.authSessionString = sessionString
                    console.log('   [Worker] Сессия сохранена после истечения токена')
                  } catch (getMeError: any) {
                    console.log('   [Worker] ❌ getMe() ошибка после истечения токена:', getMeError.errorMessage || getMeError.message)
                    // ВАЖНО: Проверяем, действительно ли требуется пароль
                    if (getMeError.errorMessage?.includes('PASSWORD') || 
                        getMeError.errorMessage?.includes('SESSION_PASSWORD_NEEDED')) {
                      // Проверяем, действительно ли включена 2FA
                      try {
                        const passwordInfo = await client.invoke(new Api.account.GetPassword())
                        if (passwordInfo && passwordInfo.hasPassword) {
                          console.log('   [Worker] ⚠️ Требуется пароль 2FA (2FA включена)')
                          sessionEntry.authPasswordRequired = true
                        } else {
                          console.log('   [Worker] ✅ 2FA отключена, пароль не требуется')
                          // Не устанавливаем флаг пароля
                        }
                      } catch (checkPasswordError: any) {
                        console.log('   [Worker] ⚠️ Не удалось проверить статус 2FA, продолжаю без пароля')
                      }
                    }
                    // Если другая ошибка, не устанавливаем флаг пароля
                  }
                } else if (migrateError.errorMessage?.includes('PASSWORD') || 
                    migrateError.errorMessage?.includes('SESSION_PASSWORD_NEEDED') ||
                    migrateError.message?.includes('PASSWORD')) {
                  console.log('   [Worker] ⚠️ Требуется пароль 2FA после миграции (из ошибки)')
                  sessionEntry.authPasswordRequired = true
                } else {
                  // Если другая ошибка, пробуем проверить через getMe
                  console.log('   [Worker] Проверяю через getMe() после ошибки миграции...')
                  try {
                    const me = await client.getMe()
                    console.log('   [Worker] ✅ getMe() успешен после ошибки миграции:', me.id)
                    const sessionString = client.session.save() as unknown as string
                    sessionEntry.authResolved = true
                    sessionEntry.authSessionString = sessionString
                  } catch (getMeError: any) {
                    console.log('   [Worker] ❌ getMe() ошибка после миграции:', getMeError.errorMessage || getMeError.message)
                    if (getMeError.errorMessage?.includes('PASSWORD') || 
                        getMeError.errorMessage?.includes('SESSION_PASSWORD_NEEDED')) {
                      console.log('   [Worker] ⚠️ Требуется пароль 2FA (определено через getMe)')
                      sessionEntry.authPasswordRequired = true
                    } else {
                      // Если другая ошибка, все равно пробуем установить флаг пароля
                      console.log('   [Worker] ⚠️ Устанавливаю флаг password_required из-за ошибки getMe')
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
    // Это может сработать даже после истечения токена миграции, если сессия частично зарегистрирована
    try {
      console.log('   [Worker] Проверяю авторизацию через getMe()...')
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
      console.log('   [Worker] getMe() ошибка:', getMeError.errorMessage || getMeError.message)
      if (getMeError.errorMessage?.includes('PASSWORD') || getMeError.errorMessage?.includes('SESSION_PASSWORD_NEEDED')) {
        // ВАЖНО: Проверяем, действительно ли включена 2FA перед установкой флага
        try {
          const passwordInfo = await client.invoke(new Api.account.GetPassword())
          if (passwordInfo && passwordInfo.hasPassword) {
            console.log('   [Worker] ⚠️ 2FA включена, требуется пароль')
            sessionData.authPasswordRequired = true
            return res.json({
              status: 'password_required',
              hint: getMeError.hint || 'Требуется пароль двухфакторной аутентификации',
            })
          } else {
            console.log('   [Worker] ✅ 2FA отключена, продолжаю без пароля')
            // Не устанавливаем флаг пароля, продолжаем проверку
          }
        } catch (checkPasswordError: any) {
          console.log('   [Worker] ⚠️ Не удалось проверить статус 2FA, продолжаю без пароля')
          // Не устанавливаем флаг пароля, продолжаем проверку
        }
      }
      // Если другая ошибка (например, AUTH_KEY_UNREGISTERED), продолжаем проверку
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
      console.log('   [Worker] 🔐 Проверяю пароль 2FA...')
      
      // Пробуем получить информацию о пароле
      let passwordInfo
      try {
        passwordInfo = await client.invoke(new Api.account.GetPassword())
        console.log('   [Worker] ✅ Получена информация о пароле')
      } catch (getPasswordError: any) {
        console.log('   [Worker] ⚠️ Не удалось получить информацию о пароле:', getPasswordError.errorMessage || getPasswordError.message)
        
        // Если сессия не зарегистрирована, пробуем повторно получить токен для использования с паролем
        if (getPasswordError.errorMessage?.includes('AUTH_KEY_UNREGISTERED') || 
            getPasswordError.errorMessage?.includes('SESSION_PASSWORD_NEEDED')) {
          
          console.log('   [Worker] 🔄 Сессия не зарегистрирована, пробую получить новый токен для пароля...')
          
          try {
            // Пробуем повторно вызвать ExportLoginToken, чтобы получить новый токен
            const apiId = process.env.TELEGRAM_API_ID ? parseInt(process.env.TELEGRAM_API_ID) : DEFAULT_API_ID
            const apiHash = process.env.TELEGRAM_API_HASH || DEFAULT_API_HASH
            
            const exportResult = await client.invoke(
              new Api.auth.ExportLoginToken({
                apiId,
                apiHash,
                exceptIds: [],
              })
            )
            
            console.log('   [Worker] Результат повторного ExportLoginToken:', exportResult.constructor.name)
            
            // Если получили LoginTokenMigrateTo, импортируем токен
            if (exportResult instanceof Api.auth.LoginTokenMigrateTo) {
              console.log('   [Worker] 🔄 Повторная миграция на DC:', exportResult.dcId)
              
              try {
                const migrateResult = await client.invoke(
                  new Api.auth.ImportLoginToken({
                    token: exportResult.token,
                  })
                )
                
                // Если получили LoginTokenSuccess, авторизация прошла
                if (migrateResult instanceof Api.auth.LoginTokenSuccess) {
                  const sessionString = client.session.save() as unknown as string
                  authSessions.delete(authToken)
                  
                  try {
                    await client.disconnect()
                  } catch (e) {
                    // Игнорируем ошибки отключения
                  }
                  
                  console.log('   [Worker] ✅ Авторизация успешна после повторной миграции')
                  return res.json({
                    status: 'success',
                    sessionString,
                  })
                }
                
                // Если требуется пароль, пробуем использовать CheckPassword
                // Но для этого все равно нужна информация о пароле
                throw new Error('После миграции требуется пароль, но не удалось получить информацию о пароле. Попробуйте обновить страницу и начать заново.')
              } catch (migrateError: any) {
                console.log('   [Worker] ❌ Ошибка при повторной миграции:', migrateError.errorMessage || migrateError.message)
                
                // Если токен истек или требуется пароль, пробуем использовать пароль напрямую
                if (migrateError.errorMessage?.includes('AUTH_TOKEN_EXPIRED') ||
                    migrateError.errorMessage?.includes('TOKEN_EXPIRED') ||
                    migrateError.errorMessage?.includes('PASSWORD') ||
                    migrateError.errorMessage?.includes('SESSION_PASSWORD_NEEDED')) {
                  
                  // Пробуем использовать пароль напрямую через CheckPassword
                  // Для этого нужна информация о пароле, но GetPassword не работает
                  // Попробуем использовать пароль как есть (в некоторых случаях это работает)
                  console.log('   [Worker] 🔐 Пробую использовать пароль напрямую...')
                  
                  try {
                    const { computeCheck } = await import('telegram/Password')
                    
                    // Пробуем получить информацию о пароле еще раз (может сработать после миграции)
                    try {
                      passwordInfo = await client.invoke(new Api.account.GetPassword())
                      console.log('   [Worker] ✅ Получена информация о пароле после повторной миграции')
                      
                      const passwordCheck = await computeCheck(passwordInfo, password)
                      
                      await client.invoke(
                        new Api.auth.CheckPassword({
                          password: passwordCheck,
                        })
                      )
                      
                      const sessionString = client.session.save() as unknown as string
                      authSessions.delete(authToken)
                      
                      try {
                        await client.disconnect()
                      } catch (e) {
                        // Игнорируем ошибки отключения
                      }
                      
                      console.log('   [Worker] ✅ Авторизация с паролем успешна после повторной миграции')
                      return res.json({
                        status: 'success',
                        sessionString,
                      })
                    } catch (getPasswordError2: any) {
                      throw new Error('Не удалось получить информацию о пароле после миграции. Обновите страницу и начните заново.')
                    }
                  } catch (passwordError: any) {
                    throw new Error('Не удалось проверить пароль. Обновите страницу и начните заново.')
                  }
                }
                
                throw migrateError
              }
            } else if (exportResult instanceof Api.auth.LoginTokenSuccess) {
              // Успешно авторизованы без пароля
              const sessionString = client.session.save() as unknown as string
              authSessions.delete(authToken)
              
              try {
                await client.disconnect()
              } catch (e) {
                // Игнорируем ошибки отключения
              }
              
              console.log('   [Worker] ✅ Авторизация успешна без пароля')
              return res.json({
                status: 'success',
                sessionString,
              })
            }
          } catch (exportError: any) {
            console.log('   [Worker] ❌ Ошибка при повторном ExportLoginToken:', exportError.errorMessage || exportError.message)
            throw new Error('Не удалось получить новый токен. Обновите страницу и начните заново.')
          }
        }
        
        // Если не удалось, пробуем использовать пароль напрямую
        // В некоторых случаях можно использовать пароль без GetPassword
        throw new Error('Не удалось получить информацию о пароле. Попробуйте обновить страницу и начать заново.')
      }
      
      // Если получили информацию о пароле, вычисляем хеш и проверяем
      const { computeCheck } = await import('telegram/Password')
      const passwordCheck = await computeCheck(passwordInfo, password)
      
      console.log('   [Worker] Проверяю пароль через CheckPassword...')
      
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

      console.log('   [Worker] ✅ Авторизация с паролем успешна')
      return res.json({
        status: 'success',
        sessionString,
      })
    } catch (error: any) {
      console.error('   [Worker] ❌ Ошибка проверки пароля:', error)
      console.error('   [Worker] Детали ошибки:', {
        errorMessage: error.errorMessage,
        message: error.message,
        code: error.code,
      })
      
      if (error.errorMessage?.includes('PASSWORD_HASH_INVALID') || 
          error.message?.includes('PASSWORD_HASH_INVALID')) {
        return res.status(400).json({ error: 'Неверный пароль' })
      }
      
      if (error.errorMessage?.includes('AUTH_KEY_UNREGISTERED')) {
        return res.status(400).json({ 
          error: 'Сессия не зарегистрирована. Обновите страницу и начните заново.' 
        })
      }
      
      return res.status(500).json({
        error: error.message || error.errorMessage || 'Ошибка при проверке пароля',
      })
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
 * 
 * ВАЖНО: На Render.com сессия должна быть добавлена в Environment Variables вручную!
 * Этот endpoint только логирует информацию для пользователя.
 */
router.post('/save', async (req, res) => {
  try {
    const { sessionString } = req.body

    if (!sessionString) {
      return res.status(400).json({ error: 'sessionString не предоставлен' })
    }

    console.log('')
    console.log('═══════════════════════════════════════════════════════════')
    console.log('💾 [Worker] Сохранение сессии')
    console.log('═══════════════════════════════════════════════════════════')
    console.log('   Длина сессии:', sessionString.length)
    console.log('   Первые 50 символов:', sessionString.substring(0, 50) + '...')
    console.log('')
    console.log('⚠️  ВАЖНО: На Render.com сессия НЕ сохраняется автоматически!')
    console.log('   Вы должны вручную добавить её в Environment Variables:')
    console.log('   1. Откройте Render Dashboard')
    console.log('   2. Выберите ваш воркер')
    console.log('   3. Перейдите в Environment')
    console.log('   4. Добавьте: TELEGRAM_SESSION_STRING="' + sessionString.substring(0, 50) + '..."')
    console.log('   5. Сохраните (воркер перезапустится автоматически)')
    console.log('')
    console.log('✅ После добавления в Environment Variables воркер будет использовать')
    console.log('   эту сессию при каждом перезапуске (даже после "засыпания" на free tier)')
    console.log('═══════════════════════════════════════════════════════════')
    console.log('')

    // Пробуем сохранить в .env для локальной разработки
    try {
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
      console.log('   [Worker] ✅ Сессия сохранена в .env (для локальной разработки)')
    } catch (fsError: any) {
      // Игнорируем ошибки файловой системы (на Render.com файлы могут быть недоступны)
      console.log('   [Worker] ⚠️ Не удалось сохранить в .env (это нормально на Render.com)')
    }

    return res.json({ 
      success: true,
      message: 'Сессия получена. Добавьте её в Render.com Environment Variables вручную.',
      sessionString: sessionString // Возвращаем сессию, чтобы админ-панель могла её показать
    })
  } catch (error: any) {
    console.error('❌ Ошибка сохранения сессии:', error)
    return res.status(500).json({
      error: error.message || 'Ошибка сохранения сессии',
    })
  }
})

export { router as qrAuthRouter }

