export type LogLevel = 'info' | 'warn' | 'error' | 'success';

export interface LogEntry {
  ts: string;
  level: LogLevel;
  message: string;
  source?: string;
  details?: unknown;
}

const MAX_ENTRIES = 500;

class RingLogger {
  private entries: LogEntry[] = [];

  private push(level: LogLevel, message: string, details?: unknown, source?: string) {
    const entry: LogEntry = { ts: new Date().toISOString(), level, message, source, details };
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.shift();
    const prefix = source ? `[${source}]` : '';
    const line = `${entry.ts} ${level.toUpperCase()} ${prefix} ${message}`;
    if (level === 'error') console.error(line, details ?? '');
    else if (level === 'warn') console.warn(line, details ?? '');
    else console.log(line, details ?? '');
  }

  info(message: string, details?: unknown, source?: string) { this.push('info', message, details, source); }
  warn(message: string, details?: unknown, source?: string) { this.push('warn', message, details, source); }
  error(message: string, details?: unknown, source?: string) { this.push('error', message, details, source); }
  success(message: string, details?: unknown, source?: string) { this.push('success', message, details, source); }

  getLogs(limit = 100, source?: string): LogEntry[] {
    const list = source ? this.entries.filter(e => e.source === source) : this.entries;
    return list.slice(-limit);
  }
}

export const log = new RingLogger();

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
