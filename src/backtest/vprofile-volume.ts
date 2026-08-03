// A/B: vprofile на ВРЕМЕНИ (наш прод-прокси: минуты в бине) против vprofile на
// НАСТОЯЩЕМ ОБЪЁМЕ (Binance BTCUSDT, поле v) — ради этого и строился загрузчик.
//
// Механика скопирована с SessionProfileStrategy (strategy.ts) один в один:
// бины 2 пипса, профиль прошлой UTC-сессии (≥30 бинов), POC + 70% VA,
// EMA-тренд (w7200: mid 120м, slow 480м), вход на подходе к уровню против хода
// в сторону тренда, один вход на уровень в день, cooldown 1800с; параметры
// btc-vprofile из ансамбля: thr12 / tp100 / sl60 (scaled, mult 4). Вход
// лимитный по касанию (TTL 180с), одна позиция за раз.
//
// Различие вариантов — ОДНА строка: вес бина 1 (время) или v (объём).
// Всё остальное идентично, поэтому различие результатов = вклад объёма.
//
// ЧЕСТНАЯ РАМКА: цены Binance-спота ≠ Dukascopy CFD, спред тут константный
// (2.5п масштаба, как spreadBase btcusd) — абсолютные цифры НЕ сравнимы со
// свипом; сравнимы только варианты между собой.
//
// CLI: npx tsx src/backtest/vprofile-volume.ts

import { pathToFileURL } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PIP } from '../broker/types';
import { loadBinanceM1 } from './binance-data';

const SCALE = 100_000;
const SPREAD_PIPS = 2.5;
const BIN_PIPS = 2;
const THR_PIPS = 12;
const TP_PIPS = 100;
const SL_PIPS = 60;
const COOLDOWN_MS = 1800_000;
const N_MID = 120; // w7200 → 120 минут
const TTL_MIN = 3;

interface Min {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

interface Trade {
  t: number;
  pnlUsd: number;
  reason: string;
}

function computeLevels(bins: Map<number, number>): Array<{ name: string; price: number }> {
  if (bins.size < 30) return [];
  const entries = [...bins.entries()].sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((s, [, n]) => s + n, 0);
  const binPrice = (b: number) => b * BIN_PIPS * PIP;
  let acc = 0;
  const inVa: number[] = [];
  for (const [bin, n] of entries) {
    inVa.push(bin);
    acc += n;
    if (acc >= total * 0.7) break;
  }
  return [
    { name: 'POC', price: binPrice(entries[0][0]) },
    { name: 'VAH', price: binPrice(Math.max(...inVa)) },
    { name: 'VAL', price: binPrice(Math.min(...inVa)) },
  ];
}

function run(minutes: Min[], useVolume: boolean): { trades: Trade[]; pocByDay: Map<string, number> } {
  const half = (SPREAD_PIPS * PIP) / 2;
  const aMid = 2 / (N_MID + 1);
  const aSlow = 2 / (N_MID * 4 + 1);
  let emaMid = NaN;
  let emaSlow = NaN;
  let dayKey = '';
  let bins = new Map<number, number>();
  let levels: Array<{ name: string; price: number }> = [];
  let used = new Set<string>();
  let prevMid = NaN;
  let cooldownUntil = 0;
  const pocByDay = new Map<string, number>();

  const trades: Trade[] = [];
  let pending: { side: 'BUY' | 'SELL'; price: number; placedAt: number } | null = null;
  let open: { side: 'BUY' | 'SELL'; entry: number; tp: number; sl: number } | null = null;

  for (let i = 0; i < minutes.length; i++) {
    const m = minutes[i];
    const mid = m.c;

    // 1) исполнение отложенной лимитки (касание пассивной стороны)
    if (pending) {
      if (m.t - pending.placedAt > TTL_MIN * 60_000) {
        pending = null;
      } else {
        const touch = pending.side === 'BUY' ? m.l - half <= pending.price : m.h + half >= pending.price;
        if (touch) {
          const e = pending.price;
          open = {
            side: pending.side,
            entry: e,
            tp: pending.side === 'BUY' ? e + TP_PIPS * PIP : e - TP_PIPS * PIP,
            sl: pending.side === 'BUY' ? e - SL_PIPS * PIP : e + SL_PIPS * PIP,
          };
          pending = null;
        }
      }
    }

    // 2) TP/SL открытой (SL первым — пессимизм)
    if (open) {
      if (open.side === 'BUY') {
        if (m.l - half <= open.sl) {
          trades.push({ t: m.t, pnlUsd: (open.sl - open.entry) * 1000, reason: 'SL' });
          open = null;
        } else if (m.h - half >= open.tp) {
          trades.push({ t: m.t, pnlUsd: (open.tp - open.entry) * 1000, reason: 'TP' });
          open = null;
        }
      } else {
        if (m.h + half >= open.sl) {
          trades.push({ t: m.t, pnlUsd: (open.entry - open.sl) * 1000, reason: 'SL' });
          open = null;
        } else if (m.l + half <= open.tp) {
          trades.push({ t: m.t, pnlUsd: (open.entry - open.tp) * 1000, reason: 'TP' });
          open = null;
        }
      }
    }

    // 3) EMA и смена сессии
    emaMid = Number.isFinite(emaMid) ? emaMid + aMid * (mid - emaMid) : mid;
    emaSlow = Number.isFinite(emaSlow) ? emaSlow + aSlow * (mid - emaSlow) : mid;
    const day = new Date(m.t).toISOString().slice(0, 10);
    if (day !== dayKey) {
      if (dayKey) {
        levels = computeLevels(bins);
        const poc = levels.find(l => l.name === 'POC');
        if (poc) pocByDay.set(dayKey, poc.price);
      }
      dayKey = day;
      bins = new Map();
      used = new Set();
    }
    const bin = Math.round(mid / (BIN_PIPS * PIP));
    bins.set(bin, (bins.get(bin) ?? 0) + (useVolume ? m.v : 1)); // ← ЕДИНСТВЕННОЕ различие вариантов

    // 4) сигнал (только без позиции/заявки)
    const prev = prevMid;
    prevMid = mid;
    if (open || pending || !Number.isFinite(prev) || !levels.length || m.t < cooldownUntil) continue;
    const upTrend = emaMid > emaSlow && mid > emaSlow;
    const dnTrend = emaMid < emaSlow && mid < emaSlow;
    if (!upTrend && !dnTrend) continue;
    const tol = THR_PIPS * PIP;
    for (const lv of levels) {
      if (used.has(lv.name)) continue;
      if (Math.abs(mid - lv.price) > tol) continue;
      if (upTrend && prev > lv.price + tol) {
        used.add(lv.name);
        cooldownUntil = m.t + COOLDOWN_MS;
        pending = { side: 'BUY', price: mid - half, placedAt: m.t };
        break;
      }
      if (dnTrend && prev < lv.price - tol) {
        used.add(lv.name);
        cooldownUntil = m.t + COOLDOWN_MS;
        pending = { side: 'SELL', price: mid + half, placedAt: m.t };
        break;
      }
    }
  }
  return { trades, pocByDay };
}

function summarize(trades: Trade[]): { n: number; net: number; wr: number; trainNet: number; testNet: number; trainN: number; testN: number } {
  const cut = Math.floor(trades.length * 0.7);
  const sum = (xs: Trade[]) => xs.reduce((s, x) => s + x.pnlUsd, 0);
  const wins = trades.filter(t => t.pnlUsd > 0).length;
  return {
    n: trades.length,
    net: +sum(trades).toFixed(2),
    wr: trades.length ? +(wins / trades.length * 100).toFixed(1) : 0,
    trainNet: +sum(trades.slice(0, cut)).toFixed(2),
    trainN: cut,
    testNet: +sum(trades.slice(cut)).toFixed(2),
    testN: trades.length - cut,
  };
}

function parseArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  (async () => {
    const from = new Date(parseArg('from') ?? '2024-01-01');
    const to = new Date(parseArg('to') ?? '2026-07-30');
    const raw = await loadBinanceM1('BTCUSDT', from, to);
    const minutes: Min[] = raw.map(c => ({ t: c.t, o: c.o / SCALE, h: c.h / SCALE, l: c.l / SCALE, c: c.c / SCALE, v: c.v }));
    console.log(`BTCUSDT: ${minutes.length} минуток, объёмных нулей ${minutes.filter(m => !m.v).length}`);

    const time = run(minutes, false);
    const vol = run(minutes, true);

    // насколько вообще расходятся уровни: |POC_time − POC_vol| по дням
    let same = 0;
    let cnt = 0;
    let diffSum = 0;
    for (const [day, p] of time.pocByDay) {
      const pv = vol.pocByDay.get(day);
      if (pv === undefined) continue;
      cnt += 1;
      const diffPips = Math.abs(p - pv) / PIP;
      diffSum += diffPips;
      if (diffPips < BIN_PIPS) same += 1;
    }
    console.log(`POC совпадает (в пределах бина): ${cnt ? (same / cnt * 100).toFixed(0) : '—'}% дней, средний |ΔPOC| ${(cnt ? diffSum / cnt : 0).toFixed(1)}п\n`);

    const ts = summarize(time.trades);
    const vs = summarize(vol.trades);
    console.log(`ВРЕМЯ  (прод-прокси): n=${ts.n} net ${ts.net}$ wr ${ts.wr}% · train ${ts.trainNet}$ (${ts.trainN}) / test ${ts.testNet}$ (${ts.testN})`);
    console.log(`ОБЪЁМ  (настоящий):   n=${vs.n} net ${vs.net}$ wr ${vs.wr}% · train ${vs.trainNet}$ (${vs.trainN}) / test ${vs.testNet}$ (${vs.testN})`);

    const outPath = path.join(process.cwd(), 'data', 'vprofile-volume-report.json');
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify({ from, to, pocAgreePct: cnt ? +(same / cnt * 100).toFixed(0) : null, meanPocDiffPips: +(cnt ? diffSum / cnt : 0).toFixed(1), time: ts, volume: vs }, null, 1));
    console.log(`\nJSON: ${outPath}\nDONE`);
  })().catch(e => {
    console.error(e);
    process.exit(1);
  });
}
