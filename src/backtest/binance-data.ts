// Загрузка минутной истории Binance (spot, data-api.binance.vision — публичный
// дата-домен, доступен и из US-региона, где живёт наш Render). Даёт то, чего
// нет у Dukascopy: мемкоины и НАСТОЯЩИЙ биржевой объём (в Candle.v).
// Кэш: data/binance-cache/<SYMBOL>-<YYYY-MM>.json — месяц минуток на файл.
//
// CLI: npx tsx src/backtest/binance-data.ts --symbol DOGEUSDT --from 2024-01-01

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { request } from 'undici';
import { log } from '../logger';
import type { Candle } from './data';

const BASE = 'https://data-api.binance.vision';

interface BnCandle extends Candle {
  v: number; // объём базового актива за минуту
}

async function fetchKlines(symbol: string, startMs: number, endMs: number): Promise<BnCandle[]> {
  const url = `${BASE}/api/v3/klines?symbol=${symbol}&interval=1m&startTime=${startMs}&endTime=${endMs}&limit=1000`;
  const res = await request(url, { headersTimeout: 15_000, bodyTimeout: 20_000 });
  const text = await res.body.text();
  if (res.statusCode !== 200) throw new Error(`binance klines ${symbol}: HTTP ${res.statusCode} ${text.slice(0, 100)}`);
  const rows = JSON.parse(text) as Array<[number, string, string, string, string, string, ...unknown[]]>;
  return rows.map(r => ({
    t: r[0], o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]), v: Number(r[5]),
  }));
}

function monthKey(t: number): string {
  return new Date(t).toISOString().slice(0, 7);
}

function cachePath(symbol: string, month: string): string {
  return path.join(process.cwd(), 'data', 'binance-cache', `${symbol}-${month}.json`);
}

/** Месяц минуток: из кэша или с биржи (пагинация по 1000 баров, пауза 120мс). */
async function loadMonth(symbol: string, month: string, isCurrentMonth: boolean): Promise<BnCandle[]> {
  const file = cachePath(symbol, month);
  // текущий (незавершённый) месяц не кэшируем намертво — перекачиваем
  if (existsSync(file) && !isCurrentMonth) {
    return JSON.parse(readFileSync(file, 'utf8')) as BnCandle[];
  }
  const start = new Date(`${month}-01T00:00:00Z`).getTime();
  const end = Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1) - 1;
  const out: BnCandle[] = [];
  let cursor = start;
  while (cursor < Math.min(end, Date.now())) {
    const batch = await fetchKlines(symbol, cursor, end);
    if (!batch.length) break;
    out.push(...batch);
    cursor = batch[batch.length - 1].t + 60_000;
    if (batch.length < 1000) break;
    await new Promise(r => setTimeout(r, 120));
  }
  if (out.length && !isCurrentMonth) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(out));
  }
  return out;
}

export async function loadBinanceM1(symbol: string, from: Date, to: Date): Promise<BnCandle[]> {
  log.info(`Binance M1 ${symbol}: ${from.toISOString().slice(0, 10)} → ${to.toISOString().slice(0, 10)}`, undefined, 'backtest');
  const months: string[] = [];
  const cur = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  while (cur.getTime() < to.getTime()) {
    months.push(cur.toISOString().slice(0, 7));
    cur.setUTCMonth(cur.getUTCMonth() + 1);
  }
  const nowMonth = monthKey(Date.now());
  const out: BnCandle[] = [];
  for (const m of months) {
    const candles = await loadMonth(symbol, m, m === nowMonth);
    out.push(...candles.filter(c => c.t >= from.getTime() && c.t < to.getTime()));
  }
  log.info(`получено ${out.length} минуток (${symbol})`, undefined, 'backtest');
  return out;
}

function parseArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  (async () => {
    const symbol = parseArg('symbol') ?? 'DOGEUSDT';
    const from = new Date(parseArg('from') ?? '2024-01-01');
    const to = new Date(parseArg('to') ?? new Date().toISOString().slice(0, 10));
    const c = await loadBinanceM1(symbol, from, to);
    if (c.length) {
      console.log(`OK: ${c.length} минуток, ${new Date(c[0].t).toISOString()} → ${new Date(c[c.length - 1].t).toISOString()}`);
    } else {
      console.log('Данных нет');
    }
  })().catch(e => {
    console.error(e);
    process.exit(1);
  });
}
