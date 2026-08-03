// Загрузка минутной истории Московской биржи через публичный ISS API —
// бесплатный, без ключей: https://iss.moex.com/iss/reference/
// Свечи M1 по акциям основного режима TQBR. Время у ISS московское (UTC+3,
// без переходов) — конвертируем в UTC. Кэш: data/moex-cache/<SECID>-<YYYY-MM>.json.
//
// CLI: npx tsx src/backtest/moex-data.ts --secid SBER --from 2024-01-01

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { request } from 'undici';
import { log } from '../logger';
import type { Candle } from './data';

const BASE = 'https://iss.moex.com/iss/engines/stock/markets/shares/boards/TQBR/securities';
const MSK_OFFSET_MS = 3 * 3600_000;

export interface MoexCandle extends Candle {
  v: number;   // объём, штук
  val: number; // оборот, ₽
}

async function fetchPage(secid: string, fromDay: string, tillDay: string, start: number): Promise<MoexCandle[]> {
  const url = `${BASE}/${secid}/candles.json?interval=1&from=${fromDay}&till=${tillDay}&start=${start}`;
  const res = await request(url, { headersTimeout: 20_000, bodyTimeout: 30_000 });
  const text = await res.body.text();
  if (res.statusCode !== 200) throw new Error(`ISS ${secid}: HTTP ${res.statusCode} ${text.slice(0, 80)}`);
  const j = JSON.parse(text);
  const cols: string[] = j.candles.columns;
  const iO = cols.indexOf('open');
  const iC = cols.indexOf('close');
  const iH = cols.indexOf('high');
  const iL = cols.indexOf('low');
  const iVal = cols.indexOf('value');
  const iVol = cols.indexOf('volume');
  const iBegin = cols.indexOf('begin');
  return (j.candles.data as any[][]).map(r => ({
    t: new Date(String(r[iBegin]).replace(' ', 'T') + 'Z').getTime() - MSK_OFFSET_MS,
    o: r[iO], h: r[iH], l: r[iL], c: r[iC], v: r[iVol], val: r[iVal],
  }));
}

async function loadMonth(secid: string, month: string, isCurrent: boolean): Promise<MoexCandle[]> {
  const file = path.join(process.cwd(), 'data', 'moex-cache', `${secid}-${month}.json`);
  if (existsSync(file) && !isCurrent) return JSON.parse(readFileSync(file, 'utf8')) as MoexCandle[];
  const fromDay = `${month}-01`;
  const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  const tillDay = `${month}-${String(last).padStart(2, '0')}`;
  const out: MoexCandle[] = [];
  let start = 0;
  for (;;) {
    const page = await fetchPage(secid, fromDay, tillDay, start);
    out.push(...page);
    if (page.length < 500) break;
    start += page.length;
    await new Promise(r => setTimeout(r, 150));
  }
  if (out.length && !isCurrent) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(out));
  }
  return out;
}

export async function loadMoexM1(secid: string, from: Date, to: Date): Promise<MoexCandle[]> {
  log.info(`MOEX M1 ${secid}: ${from.toISOString().slice(0, 10)} → ${to.toISOString().slice(0, 10)}`, undefined, 'backtest');
  const months: string[] = [];
  const cur = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  while (cur.getTime() < to.getTime()) {
    months.push(cur.toISOString().slice(0, 7));
    cur.setUTCMonth(cur.getUTCMonth() + 1);
  }
  const nowMonth = new Date().toISOString().slice(0, 7);
  const out: MoexCandle[] = [];
  for (const m of months) {
    const candles = await loadMonth(secid, m, m === nowMonth);
    out.push(...candles.filter(c => c.t >= from.getTime() && c.t < to.getTime()));
  }
  log.info(`получено ${out.length} минуток (${secid})`, undefined, 'backtest');
  return out;
}

function parseArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  (async () => {
    const secid = parseArg('secid') ?? 'SBER';
    const from = new Date(parseArg('from') ?? '2024-01-01');
    const to = new Date(parseArg('to') ?? new Date().toISOString().slice(0, 10));
    const c = await loadMoexM1(secid, from, to);
    if (c.length) {
      console.log(`OK: ${c.length} минуток, ${new Date(c[0].t).toISOString()} → ${new Date(c[c.length - 1].t).toISOString()}, последняя цена ${c[c.length - 1].c}`);
    } else {
      console.log('Данных нет');
    }
  })().catch(e => {
    console.error(e);
    process.exit(1);
  });
}
