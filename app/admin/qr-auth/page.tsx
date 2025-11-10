'use client'

import { useEffect, useState } from 'react'
import Image from 'next/image'

export default function QRAuthPage() {
  const [qrCode, setQrCode] = useState<string | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'password_required' | 'success' | 'error'>('loading')
  const [sessionString, setSessionString] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [authToken, setAuthToken] = useState<string | null>(null)
  const [password, setPassword] = useState<string>('')
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [isSubmittingPassword, setIsSubmittingPassword] = useState(false)

  useEffect(() => {
    startAuth()
  }, [])

  async function startAuth() {
    try {
      setStatus('loading')
      
      // Используем воркер вместо прямого вызова API
      const workerUrl = process.env.NEXT_PUBLIC_WORKER_URL || 'http://localhost:3001'
      console.log('🚀 Начинаю QR-авторизацию...', { workerUrl })
      
      // Сначала проверяем, что воркер доступен
      try {
        const healthCheck = await fetch(`${workerUrl}/health`)
        if (!healthCheck.ok) {
          throw new Error(`Воркер не отвечает: ${healthCheck.status}`)
        }
        console.log('✅ Воркер доступен')
      } catch (healthError: any) {
        console.error('❌ Воркер недоступен:', healthError)
        throw new Error(`Не удалось подключиться к воркеру: ${healthError.message}. Проверьте NEXT_PUBLIC_WORKER_URL.`)
      }
      
      const response = await fetch(`${workerUrl}/auth/qr/start`, {
        method: 'POST',
      })
      
      console.log('📡 Ответ от /auth/qr/start:', response.status, response.statusText)

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        throw new Error(errorData.error || 'Не удалось начать авторизацию')
      }

      const data = await response.json()

      // Если уже авторизован, сразу сохраняем сессию
      if (data.success && data.sessionString) {
        console.log('✅ Уже авторизован, сохраняю сессию...')
        const saveResponse = await fetch('/api/admin/qr-auth/save', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ sessionString: data.sessionString }),
        })
        
        const saveData = await saveResponse.json()
        if (saveData.success) {
          console.log('✅ Сессия сохранена успешно')
          setSessionString(data.sessionString)
          setStatus('success')
        } else {
          setError('Ошибка сохранения сессии: ' + (saveData.error || 'неизвестная ошибка'))
          setStatus('error')
        }
        return
      }

      // Если нет QR-кода или токена, ошибка
      if (!data.qrCode || !data.authToken) {
        throw new Error('Не удалось получить QR-код')
      }

      setQrCode(data.qrCode)
      setAuthToken(data.authToken)
      setStatus('ready')

      let intervalCleared = false
      const currentAuthToken = data.authToken

      // Проверяем статус каждые 2 секунды
      const interval = setInterval(async () => {
        if (intervalCleared) return

        try {
              // Используем воркер
              const workerUrl = process.env.NEXT_PUBLIC_WORKER_URL || 'http://localhost:3001'
              console.log('🔄 Проверяю статус авторизации...', { workerUrl, authToken: currentAuthToken?.substring(0, 20) + '...' })
              
              const statusResponse = await fetch(`${workerUrl}/auth/qr/status`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({ authToken: currentAuthToken }),
              })

          console.log('📡 Ответ от воркера:', statusResponse.status, statusResponse.statusText)

          if (statusResponse.ok) {
            const statusData = await statusResponse.json()
            console.log('📦 Данные статуса:', statusData)
            
            if (statusData.status === 'success' && statusData.sessionString) {
              intervalCleared = true
              clearInterval(interval)
              
              console.log('✅ QR-авторизация успешна, сохраняю сессию...')
                  // Сохраняем сессию через воркер
                  const workerUrl = process.env.NEXT_PUBLIC_WORKER_URL || 'http://localhost:3001'
                  const saveResponse = await fetch(`${workerUrl}/auth/qr/save`, {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ sessionString: statusData.sessionString }),
                  })
              
              const saveData = await saveResponse.json()
              if (saveData.success) {
                console.log('✅ Сессия сохранена успешно')
                setSessionString(statusData.sessionString)
                setStatus('success')
              } else {
                setError('Ошибка сохранения сессии: ' + (saveData.error || 'неизвестная ошибка'))
                setStatus('error')
              }
            } else if (statusData.status === 'expired') {
              intervalCleared = true
              clearInterval(interval)
              console.log('⏰ QR-код истек')
              setError('QR-код истек. Обновите страницу.')
              setStatus('error')
            } else if (statusData.status === 'password_required') {
              intervalCleared = true
              clearInterval(interval)
              console.log('🔐 Требуется пароль 2FA')
              setStatus('password_required')
            } else if (statusData.status === 'pending') {
              console.log('⏳ Ожидание сканирования QR-кода...')
              // Продолжаем ждать
            } else {
              console.log('❓ Неизвестный статус:', statusData.status)
            }
          } else {
            const errorText = await statusResponse.text().catch(() => 'Неизвестная ошибка')
            console.error('❌ Ошибка ответа от воркера:', statusResponse.status, errorText)
            setError(`Ошибка соединения с воркером: ${statusResponse.status}`)
            setStatus('error')
            intervalCleared = true
            clearInterval(interval)
          }
        } catch (error: any) {
          console.error('❌ Ошибка проверки статуса:', error)
          console.error('   Детали:', {
            message: error.message,
            stack: error.stack,
            name: error.name,
          })
          // Не прерываем интервал при ошибке сети, продолжаем попытки
        }
      }, 2000)

      // Очищаем интервал через 15 минут (время жизни QR-кода)
      setTimeout(() => {
        if (!intervalCleared) {
          intervalCleared = true
          clearInterval(interval)
          setError('Время ожидания истекло. Обновите страницу.')
          setStatus('error')
        }
      }, 15 * 60 * 1000) // 15 минут
    } catch (error: any) {
      console.error('❌ Ошибка при запуске авторизации:', error)
      const errorMessage = error.message || 'Ошибка при запуске авторизации'
      console.error('   Детали ошибки:', {
        message: error.message,
        stack: error.stack,
        name: error.name,
      })
      setError(errorMessage)
      setStatus('error')
    }
  }

  if (status === 'loading') {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Генерирую QR-код...</p>
        </div>
      </div>
    )
  }

  if (status === 'error') {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-50">
        <div className="bg-white p-8 rounded-lg shadow-lg max-w-md w-full">
          <div className="text-red-600 text-6xl mb-4 text-center">❌</div>
          <h1 className="text-2xl font-bold mb-4 text-center">Ошибка авторизации</h1>
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
            <p className="text-red-800 whitespace-pre-wrap text-sm">{error}</p>
          </div>
          <div className="space-y-2">
            <button
              onClick={() => window.location.reload()}
              className="w-full px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
            >
              Попробовать снова
            </button>
            <button
              onClick={() => window.location.href = '/admin'}
              className="w-full px-6 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors"
            >
              Вернуться в админку
            </button>
          </div>
          <div className="mt-6 text-xs text-gray-500 text-center">
            <p>💡 Проверьте консоль браузера (F12) для деталей ошибки</p>
            <p>💡 Проверьте логи сервера Next.js</p>
          </div>
        </div>
      </div>
    )
  }

  async function handlePasswordSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!password || !authToken) return

    setIsSubmittingPassword(true)
    setPasswordError(null)

        try {
          // Используем воркер
          const workerUrl = process.env.NEXT_PUBLIC_WORKER_URL || 'http://localhost:3001'
          const response = await fetch(`${workerUrl}/auth/qr/password`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ authToken, password }),
          })

      const data = await response.json()

      if (data.status === 'success' && data.sessionString) {
        console.log('✅ Пароль проверен, сохраняю сессию...')
                  // Сохраняем сессию через воркер
                  const workerUrl = process.env.NEXT_PUBLIC_WORKER_URL || 'http://localhost:3001'
                  const saveResponse = await fetch(`${workerUrl}/auth/qr/save`, {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ sessionString: data.sessionString }),
                  })
        
        const saveData = await saveResponse.json()
        if (saveData.success) {
          console.log('✅ Сессия сохранена успешно')
          setSessionString(data.sessionString)
          setStatus('success')
        } else {
          setPasswordError('Ошибка сохранения сессии: ' + (saveData.error || 'неизвестная ошибка'))
        }
      } else {
        setPasswordError(data.error || 'Ошибка при проверке пароля')
      }
    } catch (error: any) {
      setPasswordError(error.message || 'Ошибка при отправке пароля')
    } finally {
      setIsSubmittingPassword(false)
    }
  }

  if (status === 'password_required') {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-50">
        <div className="bg-white p-8 rounded-lg shadow-lg max-w-md w-full">
          <h1 className="text-2xl font-bold mb-4 text-center">Требуется пароль 2FA</h1>
          <p className="text-gray-600 mb-6 text-center">
            У аккаунта @yummspb включена двухфакторная аутентификация.
            <br />
            Введите пароль для завершения авторизации.
          </p>

          <form onSubmit={handlePasswordSubmit} className="space-y-4">
            <div>
              <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-2">
                Пароль двухфакторной аутентификации
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                placeholder="Введите пароль"
                required
                autoFocus
              />
              {passwordError && (
                <p className="mt-2 text-sm text-red-600">{passwordError}</p>
              )}
            </div>

            <button
              type="submit"
              disabled={isSubmittingPassword || !password}
              className="w-full px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
            >
              {isSubmittingPassword ? 'Проверка...' : 'Продолжить'}
            </button>
          </form>

          <button
            onClick={() => window.location.reload()}
            className="mt-4 w-full px-6 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors"
          >
            Отмена
          </button>
        </div>
      </div>
    )
  }

  if (status === 'success') {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-50">
        <div className="bg-white p-8 rounded-lg shadow-lg max-w-2xl w-full">
          <div className="text-center mb-6">
            <div className="text-green-600 text-6xl mb-4">✅</div>
            <h1 className="text-2xl font-bold mb-2">Авторизация успешна!</h1>
            <p className="text-gray-600 mb-6">
              Сессия сгенерирована. Скопируйте её и добавьте в Render.com Environment Variables.
            </p>
          </div>

          {sessionString && (
            <div className="mb-6">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                TELEGRAM_SESSION_STRING:
              </label>
              <div className="flex gap-2">
                <textarea
                  readOnly
                  value={sessionString}
                  className="flex-1 px-4 py-2 border border-gray-300 rounded-lg font-mono text-xs bg-gray-50"
                  rows={4}
                  onClick={(e) => (e.target as HTMLTextAreaElement).select()}
                />
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(sessionString)
                    alert('✅ Сессия скопирована в буфер обмена!')
                  }}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 whitespace-nowrap"
                >
                  📋 Копировать
                </button>
              </div>
              <p className="text-xs text-gray-500 mt-2">
                ⚠️ Важно: Добавьте эту строку в Render.com → Environment Variables → TELEGRAM_SESSION_STRING
              </p>
            </div>
          )}

          <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 mb-6">
            <p className="text-sm text-yellow-800 font-medium mb-2">📋 Что делать дальше:</p>
            <ol className="text-sm text-yellow-700 space-y-1 list-decimal list-inside">
              <li>Скопируйте сессию выше (кнопка "Копировать")</li>
              <li>Откройте <a href="https://dashboard.render.com" target="_blank" rel="noopener noreferrer" className="underline">Render Dashboard</a></li>
              <li>Выберите ваш воркер (chatbot-tg)</li>
              <li>Перейдите в <strong>Environment</strong></li>
              <li>Добавьте переменную: <code className="bg-yellow-100 px-1 rounded">TELEGRAM_SESSION_STRING</code></li>
              <li>Вставьте скопированную сессию в значение</li>
              <li>Сохраните (воркер перезапустится автоматически)</li>
            </ol>
          </div>

          <div className="flex gap-4 justify-center">
            <button
              onClick={() => window.location.href = '/admin'}
              className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
            >
              Вернуться в админку
            </button>
            <button
              onClick={() => window.location.reload()}
              className="px-6 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300"
            >
              Начать заново
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex items-center justify-center min-h-screen bg-gray-50">
      <div className="bg-white p-8 rounded-lg shadow-lg max-w-md w-full">
        <h1 className="text-2xl font-bold mb-4 text-center">Авторизация через QR-код</h1>
        <p className="text-gray-600 mb-6 text-center">
          Отсканируйте QR-код в Telegram на аккаунте @yummspb
        </p>
        
        {qrCode && (
          <div className="flex justify-center mb-6">
            <Image
              src={qrCode}
              alt="QR Code для авторизации Telegram"
              width={300}
              height={300}
              className="border-4 border-gray-200 rounded-lg"
              unoptimized // base64 изображение не требует оптимизации
            />
          </div>
        )}

        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
          <p className="text-sm text-blue-800">
            <strong>Инструкция:</strong>
          </p>
          <ol className="text-sm text-blue-700 mt-2 space-y-1 list-decimal list-inside">
            <li>Откройте Telegram на телефоне с аккаунтом <strong>@yummspb</strong></li>
            <li>Перейдите в <strong>Настройки → Устройства</strong></li>
            <li>Нажмите <strong>"Подключить устройство"</strong></li>
            <li>Отсканируйте QR-код выше (как при входе в Telegram Desktop/Web)</li>
            <li>Подтвердите подключение на телефоне</li>
          </ol>
          <p className="text-xs text-blue-600 mt-2">
            ⏱ QR-код действителен 15 минут
          </p>
        </div>

        <div className="text-center space-y-4">
          <div className="inline-flex items-center space-x-2 text-gray-600">
            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-600"></div>
            <span className="text-sm">Ожидание авторизации...</span>
          </div>
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
            <p className="text-xs text-blue-700">
              <strong>💡 Откройте консоль браузера (F12)</strong> для просмотра логов
              <br />
              Если ничего не происходит, проверьте:
              <br />
              1. Воркер работает: <code className="bg-blue-100 px-1 rounded">{process.env.NEXT_PUBLIC_WORKER_URL || 'http://localhost:3001'}/health</code>
              <br />
              2. QR-код отсканирован в Telegram
              <br />
              3. Нет ошибок в консоли
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

