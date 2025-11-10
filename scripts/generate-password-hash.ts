#!/usr/bin/env tsx

/**
 * Скрипт для генерации хеша пароля для админ-панели
 * Использование: tsx scripts/generate-password-hash.ts "ваш_пароль"
 */

import bcrypt from 'bcryptjs'

const password = process.argv[2]

if (!password) {
  console.error('❌ Укажите пароль:')
  console.error('   tsx scripts/generate-password-hash.ts "ваш_пароль"')
  process.exit(1)
}

const hash = bcrypt.hashSync(password, 10)

console.log('')
console.log('✅ Хеш пароля сгенерирован:')
console.log('')
console.log(hash)
console.log('')
console.log('📋 Добавьте в Render.com Environment Variables:')
console.log(`   ADMIN_PASSWORD_HASH=${hash}`)
console.log('')

