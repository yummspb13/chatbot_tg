'use client'

import { useEffect, useState, useRef } from 'react'
import Link from 'next/link'

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
  const logsEndRef = useRef<HTMLDivElement>(null)

  const fetchLogs = async () => {
    try {
      const params = new URLSearchParams({
        limit: limit.toString(),
        stats: 'true',
      })
      if (filter !== 'all') {
        params.append('source', filter)
      }

      const response = await fetch(`/api/admin/logs?${params}`)
      if (response.ok) {
        const data = await response.json()
        setLogs(data.logs || [])
      }
    } catch (error) {
      console.error('Error fetching logs:', error)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchLogs()

    if (autoRefresh) {
      const interval = setInterval(fetchLogs, 2000) // Обновляем каждые 2 секунды
      return () => clearInterval(interval)
    }
  }, [autoRefresh, filter, limit])

  useEffect(() => {
    // Автопрокрутка к новым логам
    if (autoRefresh && logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [logs, autoRefresh])

  const clearLogs = async () => {
    if (confirm('Очистить все логи?')) {
      try {
        await fetch('/api/admin/logs', { method: 'DELETE' })
        fetchLogs()
      } catch (error) {
        console.error('Error clearing logs:', error)
      }
    }
  }

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
    return date.toLocaleTimeString('ru-RU', { 
      hour: '2-digit', 
      minute: '2-digit', 
      second: '2-digit',
      hour12: false 
    })
  }

  return (
    <div style={{ padding: '2rem', fontFamily: 'system-ui', maxWidth: '1400px', margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
        <h1>📋 Логи системы</h1>
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
          <Link href="/admin" style={{
            padding: '0.5rem 1rem',
            background: '#6c757d',
            color: 'white',
            textDecoration: 'none',
            borderRadius: '6px',
            fontSize: '0.9rem'
          }}>
            ← Назад
          </Link>
        </div>
      </div>

      <nav style={{
        display: 'flex',
        gap: '1rem',
        marginBottom: '2rem',
        paddingBottom: '1rem',
        borderBottom: '2px solid #eee'
      }}>
        <Link href="/admin" style={{ padding: '0.5rem 1rem', background: '#f0f0f0', borderRadius: '6px', textDecoration: 'none' }}>
          📊 Дашборд
        </Link>
        <Link href="/admin/channels" style={{ padding: '0.5rem 1rem', background: '#f0f0f0', borderRadius: '6px', textDecoration: 'none' }}>
          📡 Каналы
        </Link>
        <Link href="/admin/drafts" style={{ padding: '0.5rem 1rem', background: '#f0f0f0', borderRadius: '6px', textDecoration: 'none' }}>
          📝 Черновики
        </Link>
        <Link href="/admin/logs" style={{ padding: '0.5rem 1rem', background: '#667eea', color: 'white', borderRadius: '6px', textDecoration: 'none' }}>
          📋 Логи
        </Link>
      </nav>

      {/* Controls */}
      <div style={{
        display: 'flex',
        gap: '1rem',
        marginBottom: '1rem',
        padding: '1rem',
        background: '#f8f9fa',
        borderRadius: '8px',
        flexWrap: 'wrap',
        alignItems: 'center'
      }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
            style={{ width: '18px', height: '18px' }}
          />
          <span>Автообновление (2 сек)</span>
        </label>

        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span>Источник:</span>
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            style={{ padding: '0.5rem', borderRadius: '4px', border: '1px solid #ddd' }}
          >
            <option value="all">Все</option>
            <option value="webhook">Webhook</option>
            <option value="handler">Handler</option>
            <option value="worker">Worker</option>
            <option value="messageHandler">Message Handler</option>
          </select>
        </label>

        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span>Лимит:</span>
          <select
            value={limit}
            onChange={(e) => setLimit(parseInt(e.target.value))}
            style={{ padding: '0.5rem', borderRadius: '4px', border: '1px solid #ddd' }}
          >
            <option value="50">50</option>
            <option value="100">100</option>
            <option value="200">200</option>
            <option value="500">500</option>
          </select>
        </label>

        <button
          onClick={fetchLogs}
          style={{
            padding: '0.5rem 1rem',
            background: '#17a2b8',
            color: 'white',
            border: 'none',
            borderRadius: '6px',
            cursor: 'pointer'
          }}
        >
          🔄 Обновить
        </button>

        <button
          onClick={clearLogs}
          style={{
            padding: '0.5rem 1rem',
            background: '#dc3545',
            color: 'white',
            border: 'none',
            borderRadius: '6px',
            cursor: 'pointer'
          }}
        >
          🗑️ Очистить
        </button>
      </div>

      {/* Logs */}
      <div style={{
        background: '#1e1e1e',
        color: '#d4d4d4',
        padding: '1rem',
        borderRadius: '8px',
        fontFamily: 'Monaco, Menlo, "Courier New", monospace',
        fontSize: '0.85rem',
        maxHeight: '70vh',
        overflowY: 'auto',
        lineHeight: '1.6'
      }}>
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

