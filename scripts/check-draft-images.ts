#!/usr/bin/env tsx
/**
 * Скрипт для проверки изображений в черновике
 */

import { config } from 'dotenv'
import { resolve } from 'path'
config({ path: resolve(__dirname, '../.env') })

import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()

async function checkDraftImages() {
  const draftId = process.argv[2] ? parseInt(process.argv[2], 10) : null

  if (!draftId) {
    console.log('Использование: npm run check:draft:images <draftId>')
    console.log('Пример: npm run check:draft:images 12')
    process.exit(1)
  }

  console.log(`🔍 Проверка изображений для draftId: ${draftId}\n`)

  try {
    const draft = await prisma.draftEvent.findUnique({
      where: { id: draftId },
      include: { city: true },
    })

    if (!draft) {
      console.error(`❌ Черновик с id ${draftId} не найден`)
      process.exit(1)
    }

    console.log(`📋 Информация о черновике:`)
    console.log(`   ID: ${draft.id}`)
    console.log(`   Название: ${draft.title}`)
    console.log(`   Статус: ${draft.status}`)
    console.log(`   Telegram Message ID: ${draft.telegramMessageId}`)
    console.log(`   Telegram Chat ID: ${draft.telegramChatId}`)
    console.log('')

    console.log(`🖼 Изображения:`)
    console.log(`   Cover Image: ${draft.coverImage ? '✅ Есть' : '❌ Нет'}`)
    if (draft.coverImage) {
      console.log(`      URL: ${draft.coverImage.substring(0, 100)}...`)
    }

    console.log(`   Gallery: ${draft.gallery ? '✅ Есть' : '❌ Нет'}`)
    if (draft.gallery) {
      try {
        const gallery = JSON.parse(draft.gallery)
        console.log(`      Количество изображений: ${gallery.length}`)
        gallery.forEach((url: string, index: number) => {
          console.log(`      [${index}]: ${url.substring(0, 100)}...`)
        })
      } catch (error) {
        console.error(`      ❌ Ошибка парсинга gallery: ${error}`)
        console.log(`      Raw gallery: ${draft.gallery.substring(0, 200)}...`)
      }
    }

    console.log('')
    console.log(`📤 Отправлено в Афишу:`)
    if (draft.status === 'SENT_TO_AFISHA') {
      console.log(`   ✅ Да (статус: ${draft.status})`)
      console.log(`   💡 Проверьте логи Vercel для деталей отправки`)
    } else {
      console.log(`   ❌ Нет (статус: ${draft.status})`)
    }

    console.log('')
    console.log(`💡 Для проверки логов отправки:`)
    console.log(`   1. Откройте Vercel Dashboard → Functions → Logs`)
    console.log(`   2. Найдите логи с [sendDraft] для draftId: ${draftId}`)
    console.log(`   3. Проверьте наличие логов:`)
    console.log(`      - [sendDraft] ✅ CoverImage отправляется: ...`)
    console.log(`      - [sendDraft] ✅ Gallery отправляется: X изображений`)

  } catch (error: any) {
    console.error('❌ Ошибка:', error.message)
    console.error('   Stack:', error.stack)
  } finally {
    await prisma.$disconnect()
  }
}

checkDraftImages().catch(console.error)

