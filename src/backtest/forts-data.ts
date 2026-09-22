// Минутки фьючерсов FORTS через ISS (бесплатно, без ключей) со склейкой контрактов
// в непрерывный ряд. Мотив (22.09.2026, docs/STOP-ETH-2026-09-22.md §4): по живым
// кейсам верифицированные победители РФ сидят на срочном рынке (89 % оборота
// ЛЧИ-2026 — FORTS), а наши минутные паттерны на акциях «статистически есть,
// экономически нет» из-за 0.1 % комиссии и спреда 2-3 бп — на фьючерсах спред
// в 10-25 раз уже. Кэш: data/forts-cache/<SECID>-<YYYY-MM>.json.
//
// Склейка: контракты в порядке экспирации; переход на следующий за 2 торговых
// дня до последней свечи текущего; более ранние сегменты домножаются на
// отношение цен в точке перехода (back-adjust), чтобы стык не рождал ложных
// сигналов у оконных стратегий.
//
// CLI: npx tsx src/backtest/forts-data.ts --root Si --from 2026-01-01

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { request } from 'undici';
import { log } from '../logger';
import type { Candle } from './data';

const BASE = 'https://iss.moex.com/iss/engines/futures/markets/forts/securities';
const MSK_OFFSET_MS = 3 * 3600_000;
const MONTH_CODE = ['F', 'G', 'H', 'J', 'K', 'M', 'N', 'Q', 'U', 'V', 'X', 'Z'];

export interface FortsRoot {
  root: string;      // код серии: Si, BR, RI, NG, GD, SR, GZ, MX
  monthly: boolean;  // BR/NG — месячные серии, остальные — квартальные
  tick: number;      // шаг цены (для модели спреда = 1 тик)
}

export const FORTS_ROOTS: FortsRoot[] = [
  { root: 'Si', monthly: false, tick: 1 },
  { root: 'BR', monthly: true, tick: 0.01 },
  { root: 'RI', monthly: false, tick: 10 },
  { root: 'NG', monthly: true, tick: 0.001 },
  { root: 'GD', monthly: false, tick: 0.1 },
  { root: 'SR', monthly: false, tick: 1 },
  { root: 'GZ', monthly: false, tick: 1 },
  { root: 'MX', monthly: false, tick: 25 },
];

export interface FortsCandle extends Candle {
  v: number;
  secid: string;
}

async function fetchPage(secid: string, fromDay: string, tillDay: string, start: number): Promise<FortsCandle[]> {
  const url = `${BASE}/${secid}/candles.json?interval=1&from=${fromDay}&till=${tillDay}&start=${start}`;
  let res!: Awaited<ReturnType<typeof request>>;
  let text = '';
  for (let attempt = 0; ; attempt++) {
    res = await request(url, { headersTimeout: 20_000, bodyTimeout: 30_000 });
    text = await res.body.text();
    if (res.statusCode < 500 || attempt >= 4) break;
    await new Promise(r => setTimeout(r, 2000 * 2 ** attempt));
  }
  if (res.statusCode !== 200) throw new Error(`ISS ${secid}: HTTP ${res.statusCode} ${text.slice(0, 80)}`);
  const j = JSON.parse(text);
  const cols: string[] = j.candles.columns;
  const i = (k: string) => cols.indexOf(k);
  return (j.candles.data as any[][]).map(r => ({
    t: new Date(String(r[i('begin')]).replace(' ', 'T') + 'Z').getTime() - MSK_OFFSET_MS,
    o: r[i('open')], h: r[i('high')], l: r[i('low')], c: r[i('close')], v: r[i('volume')], secid,
  }));
}

async function loadMonth(secid: string, month: string, isCurrent: boolean): Promise<FortsCandle[]> {
  const file = path.join(process.cwd(), 'data', 'forts-cache', `${secid}-${month}.json`);
  if (existsSync(file) && !isCurrent) return JSON.parse(readFileSync(file, 'utf8')) as FortsCandle[];
  const fromDay = `${month}-01`;
  const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  const tillDay = `${month}-${String(last).padStart(2, '0')}`;
  const out: FortsCandle[] = [];
  let start = 0;
  for (;;) {
    const page = await fetchPage(secid, fromDay, tillDay, start);
    out.push(...page);
    if (page.length < 500) break;
    start += page.length;
    await new Promise(r => setTimeout(r, 120));
  }
  if (!isCurrent) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(out)); // пустой месяц тоже кэшируем (контракт ещё/уже не торговался)
  }
  return out;
}

/** Контракты серии, экспирирующие в окне [from−0, to+1 серия], и месяцы, за которые их грузить. */
function contractsFor(spec: FortsRoot, from: Date, to: Date): Array<{ secid: string; expiry: { y: number; m: number }; months: string[] }> {
  const out: Array<{ secid: string; expiry: { y: number; m: number }; months: string[] }> = [];
  const step = spec.monthly ? 1 : 3;
  let y = from.getUTCFullYear(), m = from.getUTCMonth() + 1;
  if (!spec.monthly) m = Math.ceil(m / 3) * 3; // ближайший квартальный месяц
  const endY = to.getUTCFullYear(), endM = to.getUTCMonth() + 1;
  for (;;) {
    const secid = `${spec.root}${MONTH_CODE[m - 1]}${y % 10}`;
    const months: string[] = [];
    const back = spec.monthly ? 1 : 3; // месяцев активной торговли до экспирации
    for (let k = back; k >= 0; k--) {
      const d = new Date(Date.UTC(y, m - 1 - k, 1));
      months.push(d.toISOString().slice(0, 7));
    }
    out.push({ secid, expiry: { y, m }, months });
    if (y > endY || (y === endY && m > endM)) break; // один контракт после окна — для склейки хвоста
    m += step;
    if (m > 12) { m -= 12; y += 1; }
  }
  return out;
}

export async function loadFortsM1(spec: FortsRoot, from: Date, to: Date): Promise<{ candles: FortsCandle[]; rolls: Array<{ t: number; from: string; to: string; ratio: number }> }> {
  log.info(`FORTS M1 ${spec.root}: ${from.toISOString().slice(0, 10)} → ${to.toISOString().slice(0, 10)}`, undefined, 'backtest');
  const nowMonth = new Date().toISOString().slice(0, 7);
  const contracts: Array<{ secid: string; candles: FortsCandle[] }> = [];
  for (const c of contractsFor(spec, from, to)) {
    const all: FortsCandle[] = [];
    for (const month of c.months) {
      if (month > nowMonth) continue;
      all.push(...await loadMonth(c.secid, month, month === nowMonth));
    }
    all.sort((a, b) => a.t - b.t);
    if (all.length) contracts.push({ secid: c.secid, candles: all });
  }
  // склейка: контракт активен до (последняя свеча − 2 торговых дня); порядок — по последней свече
  contracts.sort((a, b) => a.candles[a.candles.length - 1].t - b.candles[b.candles.length - 1].t);
  const cutoffOf = (cs: FortsCandle[]): number => {
    const days = [...new Set(cs.map(c => new Date(c.t).toISOString().slice(0, 10)))].sort();
    const day = days[Math.max(0, days.length - 3)];
    return Date.parse(day + 'T00:00:00Z');
  };
  const out: FortsCandle[] = [];
  const rolls: Array<{ t: number; from: string; to: string; ratio: number }> = [];
  let prevCutoff = -Infinity;
  for (let i = 0; i < contracts.length; i++) {
    const cur = contracts[i];
    const isLast = i === contracts.length - 1;
    const cutoff = isLast ? Infinity : cutoffOf(cur.candles);
    const seg = cur.candles.filter(c => c.t >= prevCutoff && c.t < cutoff && c.t >= from.getTime() && c.t < to.getTime());
    if (seg.length && out.length) {
      // back-adjust всего накопленного ряда к цене нового контракта в точке стыка
      const ratio = seg[0].o / out[out.length - 1].c;
      if (Number.isFinite(ratio) && ratio > 0) {
        for (const c of out) { c.o *= ratio; c.h *= ratio; c.l *= ratio; c.c *= ratio; }
        rolls.push({ t: seg[0].t, from: out[out.length - 1].secid, to: cur.secid, ratio });
      }
    }
    out.push(...seg);
    prevCutoff = cutoff;
  }
  log.info(`получено ${out.length} минуток (${spec.root}, контрактов ${contracts.length}, стыков ${rolls.length})`, undefined, 'backtest');
  return { candles: out, rolls };
}

function parseArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  (async () => {
    const root = parseArg('root') ?? 'Si';
    const spec = FORTS_ROOTS.find(r => r.root === root);
    if (!spec) throw new Error(`неизвестная серия ${root}`);
    const from = new Date(parseArg('from') ?? '2026-01-01');
    const to = new Date(parseArg('to') ?? new Date().toISOString().slice(0, 10));
    const { candles, rolls } = await loadFortsM1(spec, from, to);
    if (!candles.length) { console.log('Данных нет'); return; }
    console.log(`OK: ${candles.length} минуток, ${new Date(candles[0].t).toISOString()} → ${new Date(candles[candles.length - 1].t).toISOString()}, последняя цена ${candles[candles.length - 1].c}`);
    for (const r of rolls) console.log(`  стык ${new Date(r.t).toISOString().slice(0, 10)}: ${r.from} → ${r.to}, ratio ${r.ratio.toFixed(4)}`);
    const days = new Set(candles.map(c => new Date(c.t).toISOString().slice(0, 10)));
    console.log(`  торговых дней ${days.size}, минуток/день ${(candles.length / days.size).toFixed(0)}`);
  })().catch(e => { console.error(e); process.exit(1); });
}
