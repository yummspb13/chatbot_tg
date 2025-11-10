import { NextRequest, NextResponse } from 'next/server'
import { Api } from 'telegram/tl'
import { TelegramClient } from 'telegram'

// Храним активные сессии (в продакшене использовать Redis)
// Импортируем из start/route.ts или используем общий storage
const authSessions = new Map<string, { 
  client: TelegramClient; 
  expiresAt: number;
  authResolved?: boolean;
  authSessionString?: string | null;
  authPasswordRequired?: boolean;
  migrateToDcId?: number;
  migrateToken?: Buffer;
}>()

// Экспортируем для использования в start/route.ts
export { authSessions }

export async function POST(req: NextRequest) {
  try {
    const { authToken } = await req.json()

    if (!authToken) {
      return NextResponse.json(
        { error: 'authToken не предоставлен' },
        { status: 400 }
      )
    }

    const sessionData = authSessions.get(authToken)
    if (!sessionData) {
      return NextResponse.json({ status: 'expired' })
    }

    // Проверяем, не истек ли токен
    if (Date.now() > sessionData.expiresAt) {
      authSessions.delete(authToken)
      return NextResponse.json({ status: 'expired' })
    }

    const { client } = sessionData

    // Проверяем, не получили ли мы авторизацию через обработчик событий
    if (sessionData.authResolved && sessionData.authSessionString) {
      console.log('   [QR-Auth] ✅ Авторизация получена через обработчик событий!')
      authSessions.delete(authToken)
      
      try {
        await client.disconnect()
      } catch (e) {
        // Игнорируем ошибки отключения
      }
      
      return NextResponse.json({
        status: 'success',
        sessionString: sessionData.authSessionString,
      })
    }

    // Проверяем, требуется ли пароль (определено через обработчик)
    if (sessionData.authPasswordRequired) {
      console.log('   [QR-Auth] ⚠️ Требуется пароль 2FA (определено через обработчик)')
      return NextResponse.json({
        status: 'password_required',
        hint: 'Требуется пароль двухфакторной аутентификации',
      })
    }

    // Проверяем авторизацию
    try {
      console.log('   [QR-Auth] Проверяю авторизацию...')
      
      // Пробуем получить информацию о пользователе - это более надежный способ проверки
      try {
        const me = await client.getMe()
        if (me) {
          console.log('   [QR-Auth] ✅ getMe() успешен, пользователь авторизован:', me.id)
          const sessionString = client.session.save() as unknown as string
          console.log('   [QR-Auth] Сессия сохранена, длина:', sessionString.length)
          authSessions.delete(authToken)
          
          try {
            await client.disconnect()
          } catch (e) {
            // Игнорируем ошибки отключения
          }
          
          console.log('✅ QR-авторизация успешна, сессия получена')
          return NextResponse.json({
            status: 'success',
            sessionString,
          })
        }
      } catch (getMeError: any) {
        console.log('   [QR-Auth] getMe() ошибка:', getMeError.errorMessage || getMeError.message)
        
        // Если ошибка связана с паролем
        if (getMeError.errorMessage?.includes('PASSWORD') || getMeError.errorMessage?.includes('SESSION_PASSWORD_NEEDED')) {
          console.log('   [QR-Auth] ⚠️ Требуется пароль 2FA (определено через getMe)')
          // Обновляем флаг в сессии
          sessionData.authPasswordRequired = true
          return NextResponse.json({
            status: 'password_required',
            hint: getMeError.hint || 'Требуется пароль двухфакторной аутентификации',
          })
        }
      }
      
      // Fallback 1: Пробуем повторно вызвать ExportLoginToken
      // После сканирования QR-кода он должен вернуть LoginTokenSuccess
      try {
        const apiId = process.env.TELEGRAM_API_ID ? parseInt(process.env.TELEGRAM_API_ID) : 17349
        const apiHash = process.env.TELEGRAM_API_HASH || '344583e45741c457fe1862106095a5eb'
        
        const exportResult = await client.invoke(
          new Api.auth.ExportLoginToken({
            apiId,
            apiHash,
            exceptIds: [],
          })
        )

        if (exportResult instanceof Api.auth.LoginTokenSuccess) {
          console.log('   [QR-Auth] ✅ Авторизация успешна через повторный ExportLoginToken!')
          const sessionString = client.session.save() as unknown as string
          console.log('   [QR-Auth] Сессия сохранена, длина:', sessionString.length)
          authSessions.delete(authToken)
          
          try {
            await client.disconnect()
          } catch (e) {
            // Игнорируем ошибки отключения
          }
          
          console.log('✅ QR-авторизация успешна, сессия получена')
          return NextResponse.json({
            status: 'success',
            sessionString,
          })
        }
      } catch (exportError: any) {
        console.log('   [QR-Auth] ExportLoginToken ошибка (это нормально, если QR еще не отсканирован):', exportError.errorMessage)
        
        // Если ошибка связана с паролем
        if (exportError.errorMessage?.includes('PASSWORD') || exportError.errorMessage?.includes('SESSION_PASSWORD_NEEDED')) {
          console.log('   [QR-Auth] ⚠️ Требуется пароль 2FA (определено через ExportLoginToken)')
          sessionData.authPasswordRequired = true
          return NextResponse.json({
            status: 'password_required',
            hint: exportError.hint || 'Требуется пароль двухфакторной аутентификации',
          })
        }
      }
      
      // Fallback 2: проверяем через checkAuthorization
      const authorized = await client.checkAuthorization()
      console.log('   [QR-Auth] checkAuthorization() вернул:', authorized)
      
      if (authorized) {
        console.log('   [QR-Auth] ✅ Авторизация успешна, сохраняю сессию...')
        const sessionString = client.session.save() as unknown as string
        console.log('   [QR-Auth] Сессия сохранена, длина:', sessionString.length)
        authSessions.delete(authToken) // Удаляем после успешной авторизации
        
        // Отключаемся от клиента
        try {
          await client.disconnect()
        } catch (e) {
          // Игнорируем ошибки отключения
        }
        
        console.log('✅ QR-авторизация успешна, сессия получена')
        return NextResponse.json({
          status: 'success',
          sessionString,
        })
      } else {
        console.log('   [QR-Auth] ⏳ Авторизация еще не завершена (pending)')
      }
    } catch (authError: any) {
      console.error('   [QR-Auth] ❌ Ошибка проверки авторизации:', authError)
      console.error('   [QR-Auth] Error message:', authError.errorMessage)
      console.error('   [QR-Auth] Error code:', authError.errorCode)
      // Если ошибка связана с паролем, возвращаем специальный статус
      if (authError.errorMessage?.includes('PASSWORD') || authError.errorMessage?.includes('SESSION_PASSWORD_NEEDED')) {
        console.log('   [QR-Auth] ⚠️ Требуется пароль 2FA')
        return NextResponse.json({
          status: 'password_required',
          hint: authError.hint || 'Требуется пароль двухфакторной аутентификации',
        })
      }
      // Для других ошибок продолжаем проверку
    }

    // Проверяем, не истек ли токен через повторный запрос
    // Также проверяем, требуется ли пароль
    try {
      await client.invoke(new Api.updates.GetState())
    } catch (error: any) {
      console.log('   [QR-Auth] GetState() ошибка:', error.errorMessage)
      
      if (error.errorMessage?.includes('AUTH_TOKEN') || error.errorMessage?.includes('EXPORTED')) {
        authSessions.delete(authToken)
        return NextResponse.json({ status: 'expired' })
      }
      
      // Проверяем, требуется ли пароль
      if (error.errorMessage?.includes('PASSWORD') || error.errorMessage?.includes('SESSION_PASSWORD_NEEDED')) {
        console.log('   [QR-Auth] ⚠️ Требуется пароль 2FA (определено через GetState)')
        return NextResponse.json({
          status: 'password_required',
          hint: error.hint || 'Требуется пароль двухфакторной аутентификации',
        })
      }
    }

    // Дополнительная проверка: пробуем получить информацию о пароле
    // Если аккаунт требует пароль, это может быть определено через account.GetPassword
    try {
      const passwordInfo = await client.invoke(new Api.account.GetPassword())
      if (passwordInfo.hasPassword) {
        console.log('   [QR-Auth] У аккаунта есть пароль 2FA')
        // Если авторизация не завершена, но есть пароль, возможно требуется ввод пароля
        // Но не возвращаем password_required сразу, так как QR-код может быть еще не отсканирован
      }
    } catch (error: any) {
      // Игнорируем ошибки получения информации о пароле
      console.log('   [QR-Auth] Не удалось получить информацию о пароле (это нормально):', error.errorMessage)
    }

    return NextResponse.json({ status: 'pending' })
  } catch (error: any) {
    console.error('Ошибка проверки статуса:', error)
    return NextResponse.json(
      { error: error.message || 'Ошибка проверки статуса' },
      { status: 500 }
    )
  }
}

