#!/usr/bin/env tsx

/**
 * Скрипт для проверки всех критических переменных окружения для продакшена
 * Использование: npm run check:production:env
 */

import { config } from 'dotenv'
import { resolve } from 'path'

// Загружаем переменные окружения
config({ path: resolve(__dirname, '../.env') })

interface EnvCheck {
  name: string
  value: string | undefined
  required: boolean
  description: string
  check?: (value: string | undefined) => { valid: boolean; message?: string }
}

const checks: EnvCheck[] = [
  {
    name: 'AI_PROVIDER',
    value: process.env.AI_PROVIDER,
    required: true,
    description: 'AI провайдер (должен быть "openai" для продакшена)',
    check: (value) => {
      if (!value) {
        return { valid: false, message: 'Не установлен' }
      }
      const lower = value.toLowerCase()
      if (lower === 'mock') {
        return { valid: false, message: '⚠️ MOCK - не подходит для продакшена! Должен быть "openai"' }
      }
      if (lower !== 'openai' && lower !== 'deepseek') {
        return { valid: false, message: `Неизвестный провайдер: ${value}` }
      }
      return { valid: true }
    },
  },
  {
    name: 'OPENAI_API_KEY',
    value: process.env.OPENAI_API_KEY,
    required: true,
    description: 'OpenAI API ключ',
    check: (value) => {
      if (!value) {
        return { valid: false, message: 'Не установлен' }
      }
      if (!value.startsWith('sk-')) {
        return { valid: false, message: '⚠️ Похоже на невалидный ключ (должен начинаться с "sk-")' }
      }
      return { valid: true }
    },
  },
  {
    name: 'TELEGRAM_BOT_TOKEN',
    value: process.env.TELEGRAM_BOT_TOKEN,
    required: true,
    description: 'Telegram Bot Token',
    check: (value) => {
      if (!value) {
        return { valid: false, message: 'Не установлен' }
      }
      if (!value.includes(':')) {
        return { valid: false, message: '⚠️ Похоже на невалидный токен (должен содержать ":")' }
      }
      return { valid: true }
    },
  },
  {
    name: 'TELEGRAM_ADMIN_CHAT_ID',
    value: process.env.TELEGRAM_ADMIN_CHAT_ID,
    required: true,
    description: 'Telegram ID администратора (для команд бота)',
    check: (value) => {
      if (!value) {
        return { valid: false, message: 'Не установлен' }
      }
      if (value !== '120352240') {
        return { valid: true, message: `⚠️ Текущее значение: ${value}, ожидается: 120352240` }
      }
      return { valid: true }
    },
  },
  {
    name: 'TELEGRAM_PUBLISH_GROUP_ID',
    value: process.env.TELEGRAM_PUBLISH_GROUP_ID,
    required: true,
    description: 'ID группы для отправки карточек одобрения',
    check: (value) => {
      if (!value) {
        return { valid: false, message: 'Не установлен' }
      }
      if (value !== '-4993347411' && value !== '4993347411') {
        return { valid: true, message: `⚠️ Текущее значение: ${value}, ожидается: -4993347411` }
      }
      return { valid: true }
    },
  },
  {
    name: 'DATABASE_URL',
    value: process.env.DATABASE_URL,
    required: true,
    description: 'Строка подключения к базе данных',
    check: (value) => {
      if (!value) {
        return { valid: false, message: 'Не установлен' }
      }
      if (value.includes('file:') && value.includes('dev.db')) {
        return { valid: true, message: '⚠️ Используется SQLite (dev.db) - для продакшена нужен PostgreSQL' }
      }
      return { valid: true }
    },
  },
  {
    name: 'BOT_API_KEY',
    value: process.env.BOT_API_KEY,
    required: false,
    description: 'API ключ для связи между Worker и основным приложением',
  },
  {
    name: 'JWT_SECRET',
    value: process.env.JWT_SECRET,
    required: true,
    description: 'Секретный ключ для JWT токенов',
    check: (value) => {
      if (!value) {
        return { valid: false, message: 'Не установлен' }
      }
      if (value.length < 32) {
        return { valid: false, message: '⚠️ Слишком короткий (минимум 32 символа)' }
      }
      return { valid: true }
    },
  },
  {
    name: 'ADMIN_PASSWORD_HASH',
    value: process.env.ADMIN_PASSWORD_HASH,
    required: true,
    description: 'Хеш пароля администратора',
    check: (value) => {
      if (!value) {
        return { valid: false, message: 'Не установлен' }
      }
      if (!value.startsWith('$2a$') && !value.startsWith('$2b$')) {
        return { valid: false, message: '⚠️ Похоже на невалидный bcrypt хеш' }
      }
      return { valid: true }
    },
  },
]

// Worker-specific checks
const workerChecks: EnvCheck[] = [
  {
    name: 'MAIN_APP_URL',
    value: process.env.MAIN_APP_URL,
    required: true,
    description: 'URL основного приложения (Vercel) для Worker',
    check: (value) => {
      if (!value) {
        return { valid: false, message: 'Не установлен' }
      }
      if (value.includes('localhost')) {
        return { valid: true, message: '⚠️ Используется localhost - для продакшена нужен Vercel URL' }
      }
      if (!value.startsWith('https://')) {
        return { valid: true, message: '⚠️ Должен начинаться с https:// для продакшена' }
      }
      return { valid: true }
    },
  },
  {
    name: 'BOT_WEBHOOK_URL',
    value: process.env.BOT_WEBHOOK_URL,
    required: false,
    description: 'Полный URL webhook (опционально, используется MAIN_APP_URL если не установлен)',
  },
  {
    name: 'TELEGRAM_API_ID',
    value: process.env.TELEGRAM_API_ID,
    required: true,
    description: 'Telegram API ID для Client API',
  },
  {
    name: 'TELEGRAM_API_HASH',
    value: process.env.TELEGRAM_API_HASH,
    required: true,
    description: 'Telegram API Hash для Client API',
  },
  {
    name: 'TELEGRAM_SESSION_STRING',
    value: process.env.TELEGRAM_SESSION_STRING,
    required: true,
    description: 'Telegram Session String для Client API',
    check: (value) => {
      if (!value) {
        return { valid: false, message: 'Не установлен' }
      }
      if (value.length < 50) {
        return { valid: true, message: '⚠️ Похоже на невалидную сессию' }
      }
      return { valid: true }
    },
  },
]

function checkEnv(check: EnvCheck): { valid: boolean; message: string } {
  if (!check.value && check.required) {
    return { valid: false, message: '❌ Не установлен (обязательный)' }
  }
  
  if (!check.value && !check.required) {
    return { valid: true, message: '⚠️ Не установлен (опциональный)' }
  }

  if (check.check) {
    const result = check.check(check.value)
    if (!result.valid) {
      return { valid: false, message: `❌ ${result.message || 'Невалидное значение'}` }
    }
    if (result.message) {
      return { valid: true, message: `✅ ${result.message}` }
    }
  }

  // Маскируем чувствительные данные
  const displayValue = check.name.includes('KEY') || check.name.includes('TOKEN') || check.name.includes('SECRET') || check.name.includes('HASH')
    ? `${check.value?.substring(0, 8)}...`
    : check.value

  return { valid: true, message: `✅ ${displayValue}` }
}

async function checkWebhook() {
  const botToken = process.env.TELEGRAM_BOT_TOKEN
  if (!botToken) {
    return { configured: false, url: null, error: 'TELEGRAM_BOT_TOKEN не установлен' }
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/getWebhookInfo`)
    const data = await response.json()

    if (data.ok && data.result.url) {
      return { configured: true, url: data.result.url, error: null }
    }
    return { configured: false, url: null, error: 'Webhook не установлен' }
  } catch (error: any) {
    return { configured: false, url: null, error: error.message }
  }
}

async function main() {
  console.log('🔍 Проверка переменных окружения для продакшена\n')
  console.log('⚠️  ВАЖНО: Этот скрипт проверяет ЛОКАЛЬНЫЙ .env файл!')
  console.log('   Для проверки продакшена проверьте вручную:')
  console.log('   - Vercel Dashboard → Settings → Environment Variables')
  console.log('   - Render.com Dashboard → ваш Worker → Environment\n')
  console.log('=' .repeat(60))
  console.log('📋 ОСНОВНОЕ ПРИЛОЖЕНИЕ (Vercel)')
  console.log('   (проверяется локальный .env файл)\n')

  let allValid = true
  let hasWarnings = false

  for (const check of checks) {
    const result = checkEnv(check)
    const status = result.valid ? '✅' : '❌'
    const warning = result.message.includes('⚠️') ? ' ⚠️' : ''
    
    console.log(`${status} ${check.name.padEnd(30)} ${result.message}`)
    
    if (!result.valid) {
      allValid = false
    }
    if (warning) {
      hasWarnings = true
    }
  }

  console.log('\n' + '='.repeat(60))
  console.log('📋 WORKER (Render.com или другой сервис)')
  console.log('   (проверяется локальный .env файл)\n')

  for (const check of workerChecks) {
    const result = checkEnv(check)
    const status = result.valid ? '✅' : '❌'
    const warning = result.message.includes('⚠️') ? ' ⚠️' : ''
    
    console.log(`${status} ${check.name.padEnd(30)} ${result.message}`)
    
    if (!result.valid) {
      allValid = false
    }
    if (warning) {
      hasWarnings = true
    }
  }

  console.log('\n' + '='.repeat(60))
  console.log('🔗 TELEGRAM WEBHOOK\n')

  const webhookInfo = await checkWebhook()
  if (webhookInfo.configured) {
    console.log(`✅ Webhook установлен: ${webhookInfo.url}`)
    
    // Проверяем, что webhook указывает на продакшен URL
    if (webhookInfo.url?.includes('localhost')) {
      console.log('⚠️  Webhook указывает на localhost - не подходит для продакшена!')
      hasWarnings = true
    } else if (webhookInfo.url?.includes('vercel.app') || webhookInfo.url?.includes('vercel.com')) {
      console.log('✅ Webhook указывает на Vercel - правильно для продакшена')
    } else {
      console.log(`⚠️  Webhook URL: ${webhookInfo.url}`)
      hasWarnings = true
    }
  } else {
    console.log(`❌ Webhook не установлен: ${webhookInfo.error}`)
    console.log('💡 Установите webhook командой: npm run webhook:set:prod <vercel-url>')
    allValid = false
  }

  console.log('\n' + '='.repeat(60))
  console.log('📊 ИТОГИ\n')

  if (allValid && !hasWarnings) {
    console.log('✅ Все проверки пройдены! Система готова к продакшену.')
  } else if (allValid && hasWarnings) {
    console.log('⚠️  Все обязательные переменные установлены, но есть предупреждения.')
    console.log('   Проверьте предупреждения выше.')
  } else {
    console.log('❌ Обнаружены критические проблемы!')
    console.log('   Исправьте ошибки выше перед деплоем на продакшен.')
  }

  console.log('\n💡 Следующие шаги:')
  console.log('   1. Если переменные установлены в Vercel/Render, но скрипт показывает ошибки:')
  console.log('      → Это нормально! Скрипт проверяет локальный .env файл')
  console.log('      → Проверьте вручную в Dashboard, что переменные установлены правильно')
  console.log('   2. Для синхронизации локального .env с продакшеном:')
  console.log('      → Обновите локальный .env файл значениями из Vercel/Render')
  console.log('      → Или используйте этот скрипт только как чеклист для ручной проверки')
  console.log('   3. Проверьте webhook: npm run webhook:check')
  console.log('   4. Проверьте логи после деплоя')
}

main().catch(console.error)

