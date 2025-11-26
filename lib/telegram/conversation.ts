/**
 * Управление диалогами с пользователем
 * Сохраняет состояние диалога для интерактивного режима
 */

import { prisma } from '@/lib/db/prisma'

export type ConversationMessage = {
  role: 'bot' | 'user'
  content: string
  timestamp: string
}

export type ConversationStatus = 'active' | 'completed' | 'cancelled'

/**
 * Создает новый диалог
 */
export async function createConversation(params: {
  telegramChatId: string
  telegramMessageId: string
  draftEventId?: number
}): Promise<number> {
  const conversation = await prisma.conversation.create({
    data: {
      telegramChatId: params.telegramChatId,
      telegramMessageId: params.telegramMessageId,
      draftEventId: params.draftEventId,
      messages: JSON.stringify([]),
      status: 'active',
    },
  })
  
  return conversation.id
}

/**
 * Добавляет сообщение в диалог
 */
export async function addMessageToConversation(
  conversationId: number,
  role: 'bot' | 'user',
  content: string
): Promise<void> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
  })
  
  if (!conversation) {
    throw new Error(`Conversation ${conversationId} not found`)
  }
  
  const messages: ConversationMessage[] = JSON.parse(conversation.messages || '[]')
  messages.push({
    role,
    content,
    timestamp: new Date().toISOString(),
  })
  
  await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      messages: JSON.stringify(messages),
    },
  })
}

/**
 * Получает активный диалог для сообщения
 */
export async function getActiveConversation(
  telegramChatId: string,
  telegramMessageId: string
): Promise<number | null> {
  const conversation = await prisma.conversation.findFirst({
    where: {
      telegramChatId,
      telegramMessageId,
      status: 'active',
    },
    orderBy: {
      createdAt: 'desc',
    },
  })
  
  return conversation?.id || null
}

/**
 * Получает диалог по ID
 */
export async function getConversation(conversationId: number) {
  return prisma.conversation.findUnique({
    where: { id: conversationId },
  })
}

/**
 * Получает все сообщения из диалога
 */
export async function getConversationMessages(conversationId: number): Promise<ConversationMessage[]> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
  })
  
  if (!conversation) {
    return []
  }
  
  return JSON.parse(conversation.messages || '[]')
}

/**
 * Завершает диалог
 */
export async function completeConversation(conversationId: number): Promise<void> {
  await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      status: 'completed',
    },
  })
}

/**
 * Отменяет диалог
 */
export async function cancelConversation(conversationId: number): Promise<void> {
  await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      status: 'cancelled',
    },
  })
}

/**
 * Получает или создает диалог для сообщения
 */
export async function getOrCreateConversation(params: {
  telegramChatId: string
  telegramMessageId: string
  draftEventId?: number
}): Promise<number> {
  // Сначала пытаемся найти активный диалог
  const existing = await getActiveConversation(params.telegramChatId, params.telegramMessageId)
  
  if (existing) {
    return existing
  }
  
  // Если нет - создаем новый
  return createConversation(params)
}

