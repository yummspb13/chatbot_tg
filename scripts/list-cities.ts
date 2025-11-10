#!/usr/bin/env tsx

/**
 * Скрипт для просмотра списка городов и их слагов
 */

import { config } from 'dotenv'
config()

import { prisma } from '@/lib/db/prisma'

async function listCities() {
  const cities = await prisma.city.findMany({
    include: {
      channels: {
        where: { isActive: true },
      },
    },
    orderBy: { name: 'asc' },
  })

  if (cities.length === 0) {
    console.log('📭 Городов пока нет в базе')
    console.log('\n💡 Добавьте город через команду:')
    console.log('   /addcity <Название города>')
    return
  }

  console.log('🏙️  Список городов:\n')
  
  for (const city of cities) {
    console.log(`   ${city.name}`)
    console.log(`   Slug: ${city.slug}`)
    console.log(`   Каналов: ${city.channels.length}`)
    if (city.channels.length > 0) {
      city.channels.forEach((ch) => {
        console.log(`     - ${ch.title} (ID: ${ch.chatId})`)
      })
    }
    console.log('')
  }

  console.log('\n📋 Для добавления канала используйте:')
  console.log('   /addchannel <slug> <chat_id> "Название канала"')
  console.log('\nПример:')
  console.log('   /addchannel sankt-peterburg -1001234567890 "Дети в Петербурге"')
}

listCities().catch(console.error)

