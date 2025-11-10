import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  console.log('Seeding database...')

  // Создаем настройки бота
  const settings = await prisma.botSettings.upsert({
    where: { id: 1 },
    update: {},
    create: {
      mode: 'MANUAL',
      confidenceThreshold: 0.8,
      isRunning: false,
    },
  })
  console.log('Bot settings created:', settings)

  // Создаем города
  const moscow = await prisma.city.upsert({
    where: { slug: 'moskva' },
    update: {},
    create: {
      name: 'Москва',
      slug: 'moskva',
    },
  })
  console.log('City created:', moscow)

  const spb = await prisma.city.upsert({
    where: { slug: 'sankt-peterburg' },
    update: {},
    create: {
      name: 'Санкт-Петербург',
      slug: 'sankt-peterburg',
    },
  })
  console.log('City created:', spb)

  // Примеры каналов (замените chatId на реальные)
  // Для тестирования можно использовать тестовые значения
  const channel1 = await prisma.channel.upsert({
    where: { chatId: '-1001234567890' },
    update: {},
    create: {
      cityId: moscow.id,
      chatId: '-1001234567890',
      title: 'Детские события Москвы (пример)',
      isActive: false, // По умолчанию неактивен, нужно активировать вручную
    },
  })
  console.log('Channel created:', channel1)

  const channel2 = await prisma.channel.upsert({
    where: { chatId: '-1001234567891' },
    update: {},
    create: {
      cityId: spb.id,
      chatId: '-1001234567891',
      title: 'Детские события СПб (пример)',
      isActive: false,
    },
  })
  console.log('Channel created:', channel2)

  console.log('Seeding completed!')
  console.log('\n⚠️  ВАЖНО:')
  console.log('1. Замените chatId в каналах на реальные ID ваших Telegram каналов')
  console.log('2. Активируйте каналы через команду /addchannel или вручную в БД')
  console.log('3. Убедитесь, что бот добавлен в каналы как администратор')
}

main()
  .catch((e) => {
    console.error('Error seeding:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })

