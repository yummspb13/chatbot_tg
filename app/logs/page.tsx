'use client'

import { useEffect, useState, useRef } from 'react'

interface LogEntry {
  id: string
  timestamp: string
  level: 'info' | 'warn' | 'error' | 'success'
  message: string
  details?: any
  source?: string
}

export default function LogsPage() {
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [filter, setFilter] = useState<string>('all')
  const [limit, setLimit] = useState(100)
  const [apiKey, setApiKey] = useState<string>('')
  const [error, setError] = useState<string>('')
  const logsEndRef = useRef<HTMLDivElement>(null)

  // Получаем API ключ из URL параметров или localStorage
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search)
    const keyFromUrl = urlParams.get('key')
    const keyFromStorage = localStorage.getItem('logs-api-key')
    
    if (keyFromUrl) {
      setApiKey(keyFromUrl)
      localStorage.setItem('logs-api-key', keyFromUrl)
    } else if (keyFromStorage) {
      setApiKey(keyFromStorage)
    }
  }, [])

  const fetchLogs = async () => {
    if (!apiKey) {
      setError('API ключ не указан. Добавьте ?key=YOUR_API_KEY в URL')
      setLoading(false)
      return
    }

    try {
      const params = new URLSearchParams({
        key: apiKey,
        limit: limit.toString(),
        stats: 'true',
      })
      if (filter !== 'all') {
        params.append('source', filter)
      }

      const response = await fetch(`/api/logs?${params}`)
      if (response.ok) {
        const data = await response.json()
        setLogs(data.logs || [])
        setError('')
      } else if (response.status === 401) {
        setError('Неверный API ключ. Проверьте ключ в URL или переменных окружения.')
        setLogs([])
      } else {
        setError(`Ошибка загрузки логов: ${response.statusText}`)
        setLogs([])
      }
    } catch (error: any) {
      setError(`Ошибка: ${error.message}`)
      setLogs([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (apiKey) {
      fetchLogs()
    }

    if (autoRefresh && apiKey) {
      const interval = setInterval(fetchLogs, 2000) // Обновляем каждые 2 секунды
      return () => clearInterval(interval)
    }
  }, [autoRefresh, filter, limit, apiKey])

  useEffect(() => {
    // Автопрокрутка к новым логам
    if (autoRefresh && logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [logs, autoRefresh])

  const getLevelColor = (level: string) => {
    switch (level) {
      case 'error':
        return '#dc3545'
      case 'warn':
        return '#ffc107'
      case 'success':
        return '#28a745'
      default:
        return '#17a2b8'
    }
  }

  const getLevelIcon = (level: string) => {
    switch (level) {
      case 'error':
        return '❌'
      case 'warn':
        return '⚠️'
      case 'success':
        return '✅'
      default:
        return 'ℹ️'
    }
  }

  const formatTime = (timestamp: string) => {
    const date = new Date(timestamp)
    return date.toLocaleTimeString('ru-RU')
  }

  if (!apiKey) {
    return (
      <div style={{ padding: '2rem', maxWidth: '800px', margin: '0 auto' }}>
        <h1 style={{ marginBottom: '1rem' }}>Просмотр логов бота</h1>
        <div style={{ padding: '1rem', background: '#fff3cd', border: '1px solid #ffc107', borderRadius: '6px', marginBottom: '1rem' }}>
          <p><strong>API ключ не указан</strong></p>
          <p>Добавьте ключ в URL: <code>?key=YOUR_API_KEY</code></p>
          <p>Или введите ключ ниже:</p>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => {
              setApiKey(e.target.value)
              localStorage.setItem('logs-api-key', e.target.value)
            }}
            placeholder="Введите API ключ"
            style={{ width: '100%', padding: '0.5rem', marginTop: '0.5rem', borderRadius: '4px', border: '1px solid #ccc' }}
          />
        </div>
      </div>
    )
  }

  return (
    <div style={{ padding: '1rem', maxWidth: '1400px', margin: '0 auto', fontFamily: 'monospace', fontSize: '14px' }}>
      <div style={{ marginBottom: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
        <h1 style={{ margin: 0 }}>Логи бота</h1>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
            />
            <span>Автообновление</span>
          </label>
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            style={{ padding: '0.25rem 0.5rem', borderRadius: '4px', border: '1px solid #ccc' }}
          >
            <option value="all">Все источники</option>
            <option value="messageHandler">Обработка сообщений</option>
            <option value="webhook">Webhook</option>
            <option value="callbackHandler">Callback</option>
          </select>
          <select
            value={limit}
            onChange={(e) => setLimit(parseInt(e.target.value))}
            style={{ padding: '0.25rem 0.5rem', borderRadius: '4px', border: '1px solid #ccc' }}
          >
            <option value="50">50</option>
            <option value="100">100</option>
            <option value="200">200</option>
            <option value="500">500</option>
          </select>
          <button
            onClick={fetchLogs}
            style={{ padding: '0.25rem 0.5rem', background: '#667eea', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
          >
            Обновить
          </button>
        </div>
      </div>

      {error && (
        <div style={{ padding: '1rem', background: '#f8d7da', border: '1px solid #dc3545', borderRadius: '6px', marginBottom: '1rem', color: '#721c24' }}>
          {error}
        </div>
      )}

      <div
        style={{
          background: '#1e1e1e',
          color: '#d4d4d4',
          padding: '1rem',
          borderRadius: '6px',
          maxHeight: '80vh',
          overflowY: 'auto',
          lineHeight: '1.6'
        }}
      >
        {loading ? (
          <div style={{ padding: '2rem', textAlign: 'center' }}>Загрузка логов...</div>
        ) : logs.length === 0 ? (
          <div style={{ padding: '2rem', textAlign: 'center', color: '#888' }}>Нет логов</div>
        ) : (
          logs.map((log) => (
            <div
              key={log.id}
              style={{
                marginBottom: '0.5rem',
                padding: '0.5rem',
                borderLeft: `3px solid ${getLevelColor(log.level)}`,
                paddingLeft: '1rem',
                background: log.level === 'error' ? 'rgba(220, 53, 69, 0.1)' : 'transparent'
              }}
            >
              <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start' }}>
                <span style={{ color: getLevelColor(log.level), minWidth: '20px' }}>
                  {getLevelIcon(log.level)}
                </span>
                <span style={{ color: '#888', minWidth: '80px' }}>
                  {formatTime(log.timestamp)}
                </span>
                {log.source && (
                  <span style={{ color: '#569cd6', minWidth: '120px' }}>
                    [{log.source}]
                  </span>
                )}
                <span style={{ flex: 1, wordBreak: 'break-word' }}>
                  {log.message}
                </span>
              </div>
              {log.details && (
                <div style={{ marginTop: '0.5rem', marginLeft: '2rem', color: '#888', fontSize: '0.8rem' }}>
                  <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
                    {typeof log.details === 'string' ? log.details : JSON.stringify(log.details, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          ))
        )}
        <div ref={logsEndRef} />
      </div>
    </div>
  )
}
