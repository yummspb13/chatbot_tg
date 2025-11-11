/**
 * Универсальный провайдер AI
 * Поддерживает OpenAI и DeepSeek API
 */

import OpenAI from 'openai'

export type AIProvider = 'openai' | 'deepseek' | 'mock'

/**
 * Создает клиент OpenAI-совместимого API
 * Поддерживает OpenAI и DeepSeek
 */
export function createAIClient() {
  const provider = (process.env.AI_PROVIDER || 'openai').toLowerCase() as AIProvider
  
  // Mock провайдер для локального тестирования
  if (provider === 'mock') {
    console.log(`🤖 AI Provider: MOCK (локальное тестирование)`)
    return {
      client: null as any, // Не используется для mock
      provider: 'mock' as const,
      getModel: () => 'mock',
    }
  }
  
  const apiKey = provider === 'deepseek' 
    ? (process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY)
    : (process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY)
  
  if (!apiKey) {
    throw new Error('AI API key not set. Set OPENAI_API_KEY or DEEPSEEK_API_KEY')
  }

  const baseURL = provider === 'deepseek' 
    ? 'https://api.deepseek.com/v1'  // DeepSeek API endpoint
    : undefined  // OpenAI использует дефолтный endpoint

  const client = new OpenAI({
    apiKey,
    baseURL,
  })

  console.log(`🤖 AI Provider: ${provider.toUpperCase()}`)
  if (baseURL) {
    console.log(`   Base URL: ${baseURL}`)
  }

  return {
    client,
    provider,
    // Получает модель в зависимости от провайдера
    getModel: (defaultModel?: string) => {
      if (provider === 'deepseek') {
        return process.env.DEEPSEEK_MODEL || 'deepseek-chat'  // DeepSeek модель
      }
      return defaultModel || process.env.OPENAI_MODEL || 'gpt-4o-mini'
    },
  }
}

/**
 * Получает клиент AI (singleton)
 */
let aiClientInstance: ReturnType<typeof createAIClient> | null = null

export function getAIClient() {
  if (!aiClientInstance) {
    aiClientInstance = createAIClient()
  }
  return aiClientInstance
}

