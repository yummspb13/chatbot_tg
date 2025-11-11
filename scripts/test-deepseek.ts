#!/usr/bin/env tsx

import { config } from 'dotenv'
import { getAIClient } from '@/lib/ai/provider'

config() // Load environment variables from .env

async function testDeepSeek() {
  try {
    console.log('🧪 Тестирую подключение к DeepSeek API...\n')
    
    const { client, provider, getModel } = getAIClient()
    console.log(`✅ AI Provider: ${provider.toUpperCase()}`)
    console.log(`✅ Model: ${getModel()}\n`)
    
    // Тестовый запрос
    console.log('📤 Отправляю тестовый запрос...')
    const response = await client.chat.completions.create({
      model: getModel(),
      messages: [
        { role: 'system', content: 'Ты помощник. Отвечай кратко.' },
        { role: 'user', content: 'Скажи "Привет" одним словом' }
      ],
      max_tokens: 10,
    })
    
    const content = response.choices[0]?.message?.content
    console.log(`✅ Ответ получен: "${content}"`)
    console.log(`✅ Использовано токенов: ${response.usage?.total_tokens}`)
    console.log('\n🎉 DeepSeek API работает отлично!')
  } catch (error: any) {
    console.error('\n❌ Ошибка:', error.message)
    if (error.response) {
      console.error('   Status:', error.response.status)
      console.error('   Data:', JSON.stringify(error.response.data, null, 2))
    }
    process.exit(1)
  }
}

testDeepSeek()

