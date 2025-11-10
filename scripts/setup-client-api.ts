#!/usr/bin/env tsx

/**
 * Скрипт для настройки Telegram Client API
 * Помогает авторизоваться и получить session string
 */

import { config } from 'dotenv'
config()

import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions'
import readline from 'readline'

const apiId = process.env.TELEGRAM_API_ID
const apiHash = process.env.TELEGRAM_API_HASH

if (!apiId || !apiHash) {
  console.error('❌ TELEGRAM_API_ID или TELEGRAM_API_HASH не установлены в .env')
  console.error('')
  console.error('💡 Как получить:')
  console.error('   1. Перейдите на https://my.telegram.org/apps')
  console.error('   2. Войдите с номером телефона аккаунта @yummspb')
  console.error('   3. Создайте приложение и получите api_id и api_hash')
  console.error('   4. Добавьте в .env:')
  console.error('      TELEGRAM_API_ID=ваш_api_id')
  console.error('      TELEGRAM_API_HASH=ваш_api_hash')
  process.exit(1)
}

// TypeScript type narrowing: после проверки выше apiId и apiHash точно не undefined
const apiIdNum = parseInt(apiId!)
const apiHashStr = apiHash!

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
})

function question(query: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(query, resolve)
  })
}

async function setup() {
  console.log('🔐 Настройка Telegram Client API')
  console.log('')
  console.log('📱 Используем аккаунт: @yummspb (7007868967)')
  console.log('')

  const session = new StringSession('')
  const client = new TelegramClient(session, apiIdNum, apiHashStr, {
    connectionRetries: 5,
  })

  await client.connect()
  console.log('✅ Подключено к Telegram')

  if (!(await client.checkAuthorization())) {
    console.log('')
    console.log('📱 Нужна авторизация')
    const phoneNumber = await question('Введите номер телефона (с кодом страны, например +79991234567): ')
    
    await client.sendCode({ apiId: parseInt(apiId), apiHash }, phoneNumber)
    
    const code = await question('Введите код из Telegram: ')
    
    try {
      await client.invoke(
        new (await import('telegram/tl')).Api.auth.SignIn({
          phoneNumber,
          phoneCodeHash: (await client.sendCode({ apiId: parseInt(apiId), apiHash }, phoneNumber)).phoneCodeHash,
          phoneCode: code,
        })
      )
    } catch (error: any) {
      if (error.errorMessage === 'SESSION_PASSWORD_NEEDED') {
        const password = await question('Введите пароль двухфакторной аутентификации: ')
        await client.invoke(
          new (await import('telegram/tl')).Api.account.GetPassword()
        )
        // Здесь нужна более сложная логика для 2FA
        console.log('⚠️ 2FA пока не поддерживается автоматически')
        console.log('💡 Временно отключите 2FA или используйте другой аккаунт')
        await client.disconnect()
        process.exit(1)
      } else {
        throw error
      }
    }
  }

  const sessionString = client.session.save() as unknown as string
  console.log('')
  console.log('✅ Авторизация успешна!')
  console.log('')
  console.log('📋 Добавьте в .env файл:')
  console.log('')
  console.log(`TELEGRAM_SESSION_STRING="${sessionString}"`)
  console.log('')
  console.log('💡 Сохраните эту строку безопасно! Она нужна для работы Client API.')
  console.log('')

  await client.disconnect()
  rl.close()
}

setup()
  .then(() => {
    console.log('✅ Настройка завершена')
    process.exit(0)
  })
  .catch((error) => {
    console.error('❌ Ошибка:', error)
    rl.close()
    process.exit(1)
  })

