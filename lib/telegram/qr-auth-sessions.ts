/**
 * Хранилище активных сессий QR-авторизации
 * В продакшене использовать Redis
 */

import { TelegramClient } from 'telegram'

export const authSessions = new Map<string, { 
  client: TelegramClient; 
  expiresAt: number;
  authResolved?: boolean;
  authSessionString?: string | null;
  authPasswordRequired?: boolean;
  migrateToDcId?: number;
  migrateToken?: Buffer;
}>()

