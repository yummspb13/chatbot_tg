#!/usr/bin/env tsx

/**
 * Генерирует MONITOR_CHANNELS из базы данных
 * Используется для воркера, когда API /api/channels не работает
 */

import { config } from 'dotenv'
config()

import { prisma } from '../lib/db/prisma'

async function generateMonitorChannels() {
  try {
    console.log('🔍 Получаю каналы из базы данных...')
    
    const channels = await prisma.channel.findMany({
      where: {
        isActive: true,
      },
      select: {
        chatId: true,
        title: true,
      },
      orderBy: {
        title: 'asc',
      },
    })

    if (channels.length === 0) {
      console.log('❌ Активных каналов не найдено')
      return
    }

    console.log(`✅ Найдено ${channels.length} активных каналов:`)
    channels.forEach(ch => {
      console.log(`   - ${ch.title} (${ch.chatId})`)
    })

    // Формируем JSON для MONITOR_CHANNELS
    const monitorChannels = channels.map(ch => ({
      chatId: ch.chatId,
      title: ch.title,
    }))

    const jsonString = JSON.stringify(monitorChannels, null, 2)
    
    console.log('')
    console.log('═══════════════════════════════════════════════════════════')
    console.log('📋 MONITOR_CHANNELS для worker/.env:')
    console.log('═══════════════════════════════════════════════════════════')
    console.log('')
    console.log(`MONITOR_CHANNELS=${JSON.stringify(monitorChannels)}`)
    console.log('')
    console.log('═══════════════════════════════════════════════════════════')
    console.log('')
    console.log('📋 Или в формате для .env (одна строка):')
    console.log('')
    console.log(`MONITOR_CHANNELS='${JSON.stringify(monitorChannels)}'`)
    console.log('')
    console.log('✅ Скопируйте эту строку в worker/.env')
    console.log('')

    // Автоматически обновляем worker/.env если он существует
    const fs = await import('fs/promises')
    const path = await import('path')
    const workerEnvPath = path.join(process.cwd(), 'worker', '.env')
    
    try {
      let workerEnv = await fs.readFile(workerEnvPath, 'utf-8')
      
      // Удаляем старый MONITOR_CHANNELS если есть
      workerEnv = workerEnv.replace(/^MONITOR_CHANNELS=.*$/m, '')
      workerEnv = workerEnv.replace(/^# Каналы для мониторинга.*$/m, '')
      workerEnv = workerEnv.replace(/^# Замените.*$/m, '')
      
      // Добавляем новый
      workerEnv += `\n# Каналы для мониторинга (автоматически сгенерировано)\n`
      workerEnv += `MONITOR_CHANNELS=${JSON.stringify(monitorChannels)}\n`
      
      await fs.writeFile(workerEnvPath, workerEnv)
      console.log('✅ worker/.env автоматически обновлен!')
      console.log('')
    } catch (error: any) {
      console.log('⚠️ Не удалось автоматически обновить worker/.env:', error.message)
      console.log('   Скопируйте MONITOR_CHANNELS вручную')
    }

  } catch (error: any) {
    console.error('❌ Ошибка:', error.message)
    process.exit(1)
  } finally {
    await prisma.$disconnect()
  }
}

generateMonitorChannels()

