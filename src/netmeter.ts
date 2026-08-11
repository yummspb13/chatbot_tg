// Сетевой метр: суммарный трафик контейнера из /proc/net/dev (все соединения —
// Express, MetaApi-стрим, Tinkoff, Telegram, Prisma) + пометражный учёт
// исходящего по маршрутам Express. Появился после двух съеденных лимитов
// Render (05.08 и 10.08): диета панели помогла, но что-то продолжает течь —
// метр показывает «кто» по динамике счётчиков.

import { readFileSync } from 'node:fs';
import type { NextFunction, Request, Response } from 'express';

interface NetTotals {
  rxBytes: number;
  txBytes: number;
}

/** Суммарные rx/tx по всем интерфейсам кроме lo. Null вне Linux. */
export function readNetTotals(): NetTotals | null {
  try {
    const lines = readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2);
    let rx = 0;
    let tx = 0;
    for (const line of lines) {
      const [name, rest] = line.split(':');
      if (!rest || name.trim() === 'lo') continue;
      const f = rest.trim().split(/\s+/);
      rx += Number(f[0]) || 0;
      tx += Number(f[8]) || 0;
    }
    return { rxBytes: rx, txBytes: tx };
  } catch {
    return null;
  }
}

const mb = (b: number) => +(b / 1024 / 1024).toFixed(1);

class NetMeter {
  private base = readNetTotals();
  private baseAt = Date.now();
  private last = this.base;
  private lastAt = Date.now();
  routeBytes = new Map<string, number>();
  routeHits = new Map<string, number>();

  /** Дельта с прошлого вызова + всего с запуска (МБ). */
  tick(): { txMb15: number; rxMb15: number; txMbTotal: number; rxMbTotal: number; sinceMin: number } | null {
    const now = readNetTotals();
    if (!now || !this.base || !this.last) return null;
    const d = {
      txMb15: mb(now.txBytes - this.last.txBytes),
      rxMb15: mb(now.rxBytes - this.last.rxBytes),
      txMbTotal: mb(now.txBytes - this.base.txBytes),
      rxMbTotal: mb(now.rxBytes - this.base.rxBytes),
      sinceMin: Math.round((Date.now() - this.baseAt) / 60_000),
    };
    this.last = now;
    this.lastAt = Date.now();
    return d;
  }

  topRoutes(n = 8): Array<{ route: string; mb: number; hits: number }> {
    return [...this.routeBytes.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([route, bytes]) => ({ route, mb: mb(bytes), hits: this.routeHits.get(route) ?? 0 }));
  }
}

export const netMeter = new NetMeter();

/** Считает фактически отправленные байты ответа (после gzip) по маршрутам. */
export function egressMeter(req: Request, res: Response, next: NextFunction): void {
  let sent = 0;
  const origWrite = res.write.bind(res);
  const origEnd = res.end.bind(res);
  res.write = ((chunk: any, ...args: any[]) => {
    if (chunk) sent += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
    return origWrite(chunk, ...args);
  }) as typeof res.write;
  res.end = ((chunk: any, ...args: any[]) => {
    if (chunk && typeof chunk !== 'function') sent += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
    return origEnd(chunk, ...args);
  }) as typeof res.end;
  res.on('finish', () => {
    const route = `${req.method} ${(req.path || '/').replace(/\/\d+/g, '/:id')}`;
    netMeter.routeBytes.set(route, (netMeter.routeBytes.get(route) ?? 0) + sent);
    netMeter.routeHits.set(route, (netMeter.routeHits.get(route) ?? 0) + 1);
  });
  next();
}
