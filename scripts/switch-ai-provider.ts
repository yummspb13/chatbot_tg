#!/usr/bin/env tsx

/**
 * Скрипт для быстрого переключения AI провайдера
 * 
 * Использование:
 *   npm run ai:switch mock      - переключить на MOCK (локальное тестирование)
 *   npm run ai:switch openai    - переключить на OpenAI
 *   npm run ai:switch deepseek  - переключить на DeepSeek
 */

import { config } from 'dotenv'
import fs from 'fs'
import path from 'path'

config() // Загружаем переменные окружения

const providers = ['mock', 'openai', 'deepseek'] as const
type Provider = typeof providers[number]

function updateEnvFile(provider: Provider) {
  const envPath = path.resolve(process.cwd(), '.env')
  let envContent = ''
  
  if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, 'utf-8')
  }
  
  // Удаляем старую строку AI_PROVIDER если есть
  envContent = envContent.replace(/^AI_PROVIDER=.*$/m, '')
  
  // Добавляем новую строку
  const newLine = `AI_PROVIDER=${provider}`
  
  // Добавляем в конец файла, если его нет
  if (!envContent.includes('AI_PROVIDER=')) {
    envContent += `\n${newLine}\n`
  } else {
    envContent += `\n${newLine}\n`
  }
  
  // Убираем лишние пустые строки
  envContent = envContent.replace(/\n{3,}/g, '\n\n').trim() + '\n'
  
  fs.writeFileSync(envPath, envContent)
  
  console.log(`✅ Переключено на провайдер: ${provider.toUpperCase()}`)
  console.log(`   Файл обновлен: ${envPath}`)
  
  // Показываем текущую конфигурацию
  console.log('\n📋 Текущая конфигурация:')
  console.log(`   AI_PROVIDER=${provider}`)
  
  if (provider === 'openai') {
    const hasKey = process.env.OPENAI_API_KEY ? '✅ установлен' : '❌ не установлен'
    console.log(`   OPENAI_API_KEY=${hasKey}`)
  }
  
  if (provider === 'deepseek') {
    const hasKey = process.env.DEEPSEEK_API_KEY ? '✅ установлен' : '❌ не установлен'
    console.log(`   DEEPSEEK_API_KEY=${hasKey}`)
  }
  
  if (provider === 'mock') {
    console.log('   (MOCK не требует API ключей)')
  }
  
  console.log('\n💡 Для применения изменений перезапустите приложение:')
  console.log('   npm run dev')
}

function showCurrentProvider() {
  const current = (process.env.AI_PROVIDER || 'openai').toLowerCase()
  console.log(`\n📊 Текущий провайдер: ${current.toUpperCase()}`)
  console.log('\nДоступные провайдеры:')
  console.log('  • mock     - Локальное тестирование (без API вызовов)')
  console.log('  • openai   - OpenAI API (требует OPENAI_API_KEY)')
  console.log('  • deepseek - DeepSeek API (требует DEEPSEEK_API_KEY)')
  console.log('\nИспользование:')
  console.log('  npm run ai:switch <provider>')
}

const provider = process.argv[2]?.toLowerCase() as Provider

if (!provider) {
  showCurrentProvider()
  process.exit(0)
}

if (!providers.includes(provider)) {
  console.error(`❌ Неизвестный провайдер: ${provider}`)
  console.error(`   Доступные: ${providers.join(', ')}`)
  process.exit(1)
}

updateEnvFile(provider)

