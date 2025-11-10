/**
 * Управление каналами (CRUD)
 * В будущем можно добавить синхронизацию с основной БД
 */

import { Router } from 'express'

const router = Router()

/**
 * GET /channels
 * Возвращает список каналов
 */
router.get('/', async (req, res) => {
  // TODO: Получить из основной БД через Prisma
  return res.json({ channels: [] })
})

export { router as channelsRouter }

