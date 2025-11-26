import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const prisma = globalForPrisma.prisma ?? new PrismaClient({
  log: process.env.NODE_ENV === 'development' 
    ? ['query', 'error', 'warn'] 
    : ['error'],
})

// Обработка ошибок подключения
prisma.$connect().catch((error) => {
  console.error('❌ Ошибка подключения к БД:', error.message)
  console.error('   Проверьте DATABASE_URL в переменных окружения')
})

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma
}

