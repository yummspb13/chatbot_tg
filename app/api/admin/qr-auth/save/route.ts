import { NextRequest, NextResponse } from 'next/server'
import { writeFile, readFile } from 'fs/promises'
import { join } from 'path'

export async function POST(req: NextRequest) {
  try {
    const { sessionString } = await req.json()

    if (!sessionString) {
      return NextResponse.json(
        { error: 'sessionString не предоставлен' },
        { status: 400 }
      )
    }

    // Читаем текущий .env файл
    const envPath = join(process.cwd(), '.env')
    let envContent = ''
    
    try {
      envContent = await readFile(envPath, 'utf-8')
    } catch (error) {
      // Файл не существует, создадим новый
      envContent = ''
    }

    // Обновляем или добавляем TELEGRAM_SESSION_STRING
    if (envContent.includes('TELEGRAM_SESSION_STRING=')) {
      envContent = envContent.replace(
        /TELEGRAM_SESSION_STRING=.*/g,
        `TELEGRAM_SESSION_STRING="${sessionString}"`
      )
    } else {
      envContent += `\nTELEGRAM_SESSION_STRING="${sessionString}"\n`
    }

    // Сохраняем обновленный .env
    try {
      await writeFile(envPath, envContent, 'utf-8')
      console.log('✅ TELEGRAM_SESSION_STRING успешно сохранен в .env')
      console.log('   Путь к файлу:', envPath)
      console.log('   Длина сессии:', sessionString.length)
      console.log('   Первые 50 символов:', sessionString.substring(0, 50))
      
      // Проверяем, что файл действительно сохранен
      const verifyContent = await readFile(envPath, 'utf-8')
      if (verifyContent.includes('TELEGRAM_SESSION_STRING=')) {
        console.log('✅ Проверка: сессия найдена в .env файле')
      } else {
        console.error('❌ Проверка: сессия НЕ найдена в .env файле после сохранения!')
      }
    } catch (writeError: any) {
      console.error('❌ Ошибка записи в .env файл:', writeError)
      console.error('   Код ошибки:', writeError.code)
      console.error('   Путь:', envPath)
      throw new Error(`Не удалось сохранить в .env: ${writeError.message}`)
    }

    return NextResponse.json({ success: true })
  } catch (error: any) {
    console.error('❌ Ошибка сохранения сессии:', error)
    console.error('   Детали:', {
      message: error.message,
      code: error.code,
      stack: error.stack,
    })
    return NextResponse.json(
      { 
        error: error.message || 'Ошибка сохранения сессии',
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined
      },
      { status: 500 }
    )
  }
}

