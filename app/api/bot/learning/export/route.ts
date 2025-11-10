import { NextRequest, NextResponse } from 'next/server'
import { exportTrainingData } from '@/lib/learning/agentTraining'

/**
 * API endpoint для экспорта данных обучения в формате JSONL для fine-tuning
 * GET /api/bot/learning/export
 */
export async function GET(req: NextRequest) {
  try {
    // Проверка авторизации (можно добавить API ключ)
    const apiKey = req.headers.get('X-API-Key')
    const expectedKey = process.env.BOT_API_KEY

    if (expectedKey && apiKey !== expectedKey) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    const data = await exportTrainingData()
    const lines = data.split('\n').filter(Boolean)

    return NextResponse.json({
      success: true,
      totalLines: lines.length,
      data: data,
      format: 'jsonl',
      description: 'Данные в формате JSONL для fine-tuning OpenAI модели',
    })
  } catch (error) {
    console.error('Error exporting training data:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

/**
 * Скачивание файла JSONL
 * GET /api/bot/learning/export?download=true
 */
export async function POST(req: NextRequest) {
  try {
    const apiKey = req.headers.get('X-API-Key')
    const expectedKey = process.env.BOT_API_KEY

    if (expectedKey && apiKey !== expectedKey) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    const data = await exportTrainingData()

    return new NextResponse(data, {
      headers: {
        'Content-Type': 'application/jsonl',
        'Content-Disposition': 'attachment; filename="training-data.jsonl"',
      },
    })
  } catch (error) {
    console.error('Error exporting training data:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

