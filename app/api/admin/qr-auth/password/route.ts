import { NextRequest, NextResponse } from 'next/server'
import { Api } from 'telegram/tl'
import { computeCheck } from 'telegram/Password'
import { authSessions } from '@/lib/telegram/qr-auth-sessions'

export async function POST(req: NextRequest) {
  try {
    const { authToken, password } = await req.json()

    if (!authToken || !password) {
      return NextResponse.json(
        { error: 'authToken и password обязательны' },
        { status: 400 }
      )
    }

    const sessionData = authSessions.get(authToken)
    if (!sessionData) {
      return NextResponse.json({ error: 'Сессия не найдена или истекла' }, { status: 400 })
    }

    const { client } = sessionData

    try {
      // Получаем информацию о пароле
      console.log('   [QR-Auth] Получаю информацию о пароле...')
      const passwordInfo = await client.invoke(new Api.account.GetPassword())
      
      // Вычисляем хеш пароля
      console.log('   [QR-Auth] Вычисляю хеш пароля...')
      const passwordCheck = await computeCheck(passwordInfo, password)
      
      // Проверяем пароль
      console.log('   [QR-Auth] Проверяю пароль...')
      const result = await client.invoke(
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
      return NextResponse.json({
        status: 'success',
        sessionString,
      })
    } catch (error: any) {
      console.error('   [QR-Auth] ❌ Ошибка проверки пароля:', error)
      if (error.errorMessage?.includes('PASSWORD_HASH_INVALID')) {
        return NextResponse.json(
          { error: 'Неверный пароль' },
          { status: 400 }
        )
      }
      throw error
    }
  } catch (error: any) {
    console.error('Ошибка при проверке пароля:', error)
    return NextResponse.json(
      { error: error.message || 'Ошибка при проверке пароля' },
      { status: 500 }
    )
  }
}

