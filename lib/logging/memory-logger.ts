/**
 * Простой логгер в память для отображения в админ-панели
 * Хранит последние N логов в памяти
 */

export interface LogEntry {
  id: string
  timestamp: string
  level: 'info' | 'warn' | 'error' | 'success'
  message: string
  details?: any
  source?: string // 'webhook', 'worker', 'handler', etc.
}

class MemoryLogger {
  private logs: LogEntry[] = []
  private maxLogs = 1000 // Храним последние 1000 логов

  log(level: LogEntry['level'], message: string, details?: any, source?: string) {
    const entry: LogEntry = {
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date().toISOString(),
      level,
      message,
      details,
      source,
    }

    this.logs.push(entry)

    // Ограничиваем количество логов
    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(-this.maxLogs)
    }

    // Также выводим в консоль для Vercel logs
    const prefix = `[${entry.timestamp}] [${source || 'SYSTEM'}]`
    switch (level) {
      case 'error':
        console.error(`${prefix} ❌ ${message}`, details || '')
        break
      case 'warn':
        console.warn(`${prefix} ⚠️ ${message}`, details || '')
        break
      case 'success':
        console.log(`${prefix} ✅ ${message}`, details || '')
        break
      default:
        console.log(`${prefix} ℹ️ ${message}`, details || '')
    }
  }

  info(message: string, details?: any, source?: string) {
    this.log('info', message, details, source)
  }

  warn(message: string, details?: any, source?: string) {
    this.log('warn', message, details, source)
  }

  error(message: string, details?: any, source?: string) {
    this.log('error', message, details, source)
  }

  success(message: string, details?: any, source?: string) {
    this.log('success', message, details, source)
  }

  getLogs(limit?: number, source?: string): LogEntry[] {
    let filtered = this.logs

    if (source) {
      filtered = filtered.filter(log => log.source === source)
    }

    if (limit) {
      filtered = filtered.slice(-limit)
    }

    return filtered.reverse() // Новые сверху
  }

  clear() {
    this.logs = []
  }

  getStats() {
    const total = this.logs.length
    const byLevel = {
      info: this.logs.filter(l => l.level === 'info').length,
      warn: this.logs.filter(l => l.level === 'warn').length,
      error: this.logs.filter(l => l.level === 'error').length,
      success: this.logs.filter(l => l.level === 'success').length,
    }
    const bySource = this.logs.reduce((acc, log) => {
      const source = log.source || 'unknown'
      acc[source] = (acc[source] || 0) + 1
      return acc
    }, {} as Record<string, number>)

    return {
      total,
      byLevel,
      bySource,
    }
  }
}

// Singleton instance
export const memoryLogger = new MemoryLogger()

