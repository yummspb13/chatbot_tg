// Тест идеи Димы (03.08): «отмечаю вчерашние хай/лоу + диапазоны Азии и Лондона;
// после 9:30 Нью-Йорка один из уровней гарантированно пробивается; вижу разворот —
// торгую инверсию, нет разворота — продолжение».
//
// Формализация (вилка определена ДО входа, иначе идея нефальсифицируема):
//   уровни: PDH/PDL (экстремумы вчерашней сессии), Азия (00-07 UTC), Лондон (07-12 UTC);
//   событие: ПЕРВЫЙ пробой любого уровня на ≥2×mult пипсов после открытия НЙ
//            (9:30 ET = 13:30/14:30 UTC по DST);
//   ложный пробой  = закрытие минутки вернулось за уровень в течение M минут
//                    → вход ПРОТИВ пробоя в момент возврата (fade-failed);
//   подтверждённый = через M минут цена всё ещё за уровнем
//                    → вход ПО пробою (follow-confirmed);
//   M ∈ {5, 15}; TP {20,40}×mult / SL 40×mult; тайм-выход 21:00 UTC (закрытие НЙ).
//   Вход рыночный с реальным полуспредом минутки. Одна сделка на сессию на ветку.
//
// Часть A отдельно проверяет само «гарантированно»: доля сессий с пробоем,
// какой уровень пробивается первым, доля ложных.
//
// Рынки: S&P500 (главный НЙ-инструмент), золото, EUR/USD. 2024-01 → 2026-07.
// Дисциплина: walk-forward 70/30 по сессиям + Бонферрони по всем ячейкам;
// результат добавляется в кумулятивный леджер гипотез.
//
// CLI: npx tsx src/backtest/ny-break.ts

import { pathToFileURL } from 'node:url';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { PIP } from '../broker/types';
import { Candle, loadM1WithSpread } from './data';
import { MARKETS, prepCandles } from './runner';

function normalQuantile(p: number): number {
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pl = 0.02425;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= 1 - pl) {
    const q = p - 0.5;
    const r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

function tStat(xs: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const mean = xs.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1));
  return sd > 0 ? mean / (sd / Math.sqrt(n)) : 0;
}

function usDst(d: Date): boolean {
  const y = d.getUTCFullYear();
  const nthSunday = (month: number, nth: number): number => {
    const first = new Date(Date.UTC(y, month, 1)).getUTCDay();
    return 1 + ((7 - first) % 7) + (nth - 1) * 7;
  };
  const start = Date.UTC(y, 2, nthSunday(2, 2), 7);
  const end = Date.UTC(y, 10, nthSunday(10, 1), 7);
  return d.getTime() >= start && d.getTime() < end;
}

interface DayCtx {
  dayStart: number; // UTC 00:00
  pdh: number;
  pdl: number;
  asiaH: number;
  asiaL: number;
  lonH: number;
  lonL: number;
  nyOpen: number;   // ms
  nyClose: number;  // 21:00 UTC
  fromIdx: number;  // первый индекс минутки >= nyOpen
}

interface BreakEvent {
  ctx: DayCtx;
  tBreakIdx: number;
  dir: 1 | -1;        // 1 = пробой вверх
  level: number;
  levelName: string;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  (async () => {
    const from = new Date(process.argv.includes('--from') ? process.argv[process.argv.indexOf('--from') + 1] : '2024-01-01');
    const to = new Date(process.argv.includes('--to') ? process.argv[process.argv.indexOf('--to') + 1] : '2026-07-30');
    const PAIRS = ['usa500idxusd', 'xauusd', 'eurusd'];
    const BRANCHES = ['fade-failed', 'follow-confirmed'] as const;
    const MS = [5, 15];
    const TPS = [20, 40];
    const totalCells = PAIRS.length * BRANCHES.length * MS.length * TPS.length;
    const zBonf = normalQuantile(1 - (0.05 / totalCells) / 2);
    console.log(`Ячеек: ${totalCells} → Бонферрони |t|≥${zBonf.toFixed(2)}\n`);

    const report: any = { from, to, zBonf, cells: [], measure: {} };

    for (const pair of PAIRS) {
      const market = MARKETS[pair];
      const mult = market.pipsMult ?? 1;
      const K = 2 * mult * PIP; // порог пробоя
      const candles = prepCandles(await loadM1WithSpread(market.instrument, from, to), market);

      // индексация по дням UTC
      const idxByDay = new Map<number, { from: number; to: number }>();
      for (let i = 0; i < candles.length; i++) {
        const day = Math.floor(candles[i].t / 86400_000) * 86400_000;
        const rec = idxByDay.get(day);
        if (!rec) idxByDay.set(day, { from: i, to: i });
        else rec.to = i;
      }

      const rangeOf = (fromT: number, toT: number, d: { from: number; to: number }): { h: number; l: number } | null => {
        let h = -Infinity;
        let l = Infinity;
        for (let i = d.from; i <= d.to; i++) {
          const c = candles[i];
          if (c.t < fromT || c.t >= toT) continue;
          if (c.h > h) h = c.h;
          if (c.l < l) l = c.l;
        }
        return h > -Infinity ? { h, l } : null;
      };

      // события: первый пробой после открытия НЙ
      const events: BreakEvent[] = [];
      let sessions = 0;
      let sessionsWithBreak = 0;
      const firstByLevel = new Map<string, number>();
      const days = [...idxByDay.keys()].sort((a, b) => a - b);
      for (let di = 1; di < days.length; di++) {
        const day = days[di];
        const prev = idxByDay.get(days[di - 1])!;
        const cur = idxByDay.get(day)!;
        if (days[di] - days[di - 1] > 3 * 86400_000) continue; // разрыв данных
        const dow = new Date(day).getUTCDay();
        if (dow === 0 || dow === 6) continue;
        const prevRange = rangeOf(days[di - 1], days[di - 1] + 86400_000, prev);
        const asia = rangeOf(day, day + 7 * 3600_000, cur);
        const lon = rangeOf(day + 7 * 3600_000, day + 12 * 3600_000, cur);
        if (!prevRange || !asia || !lon) continue;
        const nyOpen = day + (usDst(new Date(day)) ? 13.5 : 14.5) * 3600_000;
        const nyClose = day + 21 * 3600_000;
        const ctx: DayCtx = {
          dayStart: day, pdh: prevRange.h, pdl: prevRange.l,
          asiaH: asia.h, asiaL: asia.l, lonH: lon.h, lonL: lon.l,
          nyOpen, nyClose, fromIdx: -1,
        };
        sessions += 1;
        const upLevels: Array<[string, number]> = [['PDH', ctx.pdh], ['AsiaH', ctx.asiaH], ['LonH', ctx.lonH]];
        const dnLevels: Array<[string, number]> = [['PDL', ctx.pdl], ['AsiaL', ctx.asiaL], ['LonL', ctx.lonL]];
        let found = false;
        for (let i = cur.from; i <= cur.to && !found; i++) {
          const c = candles[i];
          if (c.t < nyOpen) continue;
          if (c.t >= nyClose - 30 * 60_000) break; // слишком поздно для сделки
          for (const [name, lv] of upLevels) {
            if (c.h >= lv + K) {
              events.push({ ctx, tBreakIdx: i, dir: 1, level: lv, levelName: name });
              found = true;
              break;
            }
          }
          if (found) break;
          for (const [name, lv] of dnLevels) {
            if (c.l <= lv - K) {
              events.push({ ctx, tBreakIdx: i, dir: -1, level: lv, levelName: name });
              found = true;
              break;
            }
          }
        }
        if (found) {
          sessionsWithBreak += 1;
          const name = events[events.length - 1].levelName;
          firstByLevel.set(name, (firstByLevel.get(name) ?? 0) + 1);
        }
      }

      report.measure[pair] = {
        sessions,
        withBreak: sessionsWithBreak,
        breakPct: sessions ? +(sessionsWithBreak / sessions * 100).toFixed(1) : 0,
        firstByLevel: Object.fromEntries(firstByLevel),
      };
      console.log(`===== ${pair}: сессий ${sessions}, с пробоем после НЙ-открытия: ${sessionsWithBreak} (${report.measure[pair].breakPct}%) — «гарантированно» проверено`);
      console.log(`  какой уровень первым: ${[...firstByLevel.entries()].map(([k, v]) => `${k}:${v}`).join(' · ')}`);

      // симуляция веток
      for (const M of MS) {
        // классификация: ложный/подтверждённый в течение M минут
        let failed = 0;
        let confirmed = 0;
        interface Entry {
          idx: number;
          side: 'BUY' | 'SELL';
          deadline: number;
        }
        const fadeEntries: Entry[] = [];
        const followEntries: Entry[] = [];
        for (const ev of events) {
          const mEnd = candles[ev.tBreakIdx].t + M * 60_000;
          let failIdx = -1;
          let lastInWindow = ev.tBreakIdx;
          for (let i = ev.tBreakIdx + 1; i < candles.length && candles[i].t <= mEnd; i++) {
            lastInWindow = i;
            const back = ev.dir === 1 ? candles[i].c < ev.level : candles[i].c > ev.level;
            if (back && failIdx < 0) failIdx = i;
          }
          if (failIdx >= 0) {
            failed += 1;
            fadeEntries.push({ idx: failIdx, side: ev.dir === 1 ? 'SELL' : 'BUY', deadline: ev.ctx.nyClose });
          } else if (lastInWindow > ev.tBreakIdx) {
            confirmed += 1;
            followEntries.push({ idx: lastInWindow, side: ev.dir === 1 ? 'BUY' : 'SELL', deadline: ev.ctx.nyClose });
          }
        }
        if (MS.indexOf(M) === 0) {
          console.log(`  M=${M}м: ложных ${failed}, подтверждённых ${confirmed} (доля ложных ${(failed / Math.max(1, failed + confirmed) * 100).toFixed(0)}%)`);
        }

        const sim = (e: Entry, tpPips: number, slPips: number): number | null => {
          const c0 = candles[e.idx];
          const half0 = (c0.sp ?? PIP) / 2;
          const entry = e.side === 'BUY' ? c0.c + half0 : c0.c - half0;
          const tp = e.side === 'BUY' ? entry + tpPips * PIP : entry - tpPips * PIP;
          const sl = e.side === 'BUY' ? entry - slPips * PIP : entry + slPips * PIP;
          for (let i = e.idx + 1; i < candles.length; i++) {
            const c = candles[i];
            const half = (c.sp ?? PIP) / 2;
            if (e.side === 'BUY') {
              if (c.l - half <= sl) return (sl - entry) * 1000;
              if (c.h - half >= tp) return (tp - entry) * 1000;
            } else {
              if (c.h + half >= sl) return (entry - sl) * 1000;
              if (c.l + half <= tp) return (entry - tp) * 1000;
            }
            if (c.t >= e.deadline) {
              const exit = e.side === 'BUY' ? c.c - half : c.c + half;
              return (e.side === 'BUY' ? exit - entry : entry - exit) * 1000;
            }
            if (c.t - c0.t > 86400_000) return null;
          }
          return null;
        };

        for (const branch of BRANCHES) {
          const entries = branch === 'fade-failed' ? fadeEntries : followEntries;
          for (const tp of TPS) {
            const pnls = entries.map(e => sim(e, tp * mult, 40 * mult)).filter((x): x is number => x !== null);
            if (pnls.length < 30) continue;
            const cut = Math.floor(pnls.length * 0.7);
            const train = pnls.slice(0, cut);
            const test = pnls.slice(cut);
            const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
            const cell = {
              pair, branch, M, tp: tp * mult, sl: 40 * mult,
              n: pnls.length,
              trainNet: +sum(train).toFixed(2), trainT: +tStat(train).toFixed(2),
              testNet: +sum(test).toFixed(2), testN: test.length,
              wr: +(pnls.filter(x => x > 0).length / pnls.length * 100).toFixed(1),
              pass: sum(train) > 0 && Math.abs(tStat(train)) >= zBonf && sum(test) > 0,
            };
            report.cells.push(cell);
            const mark = cell.pass ? '✅ ПРОШЛА' : cell.trainNet > 0 && cell.testNet > 0 ? '· обе половины +' : '  ';
            console.log(`  ${mark} ${branch} M${M} tp${tp}×${mult}: train ${cell.trainNet}$ (t=${cell.trainT}) · test ${cell.testNet}$ (n=${cell.testN}) · wr ${cell.wr}%`);
          }
        }
      }
      console.log('');
    }

    const passed = report.cells.filter((c: any) => c.pass);
    console.log(`ИТОГ: ячеек ${report.cells.length}, прошло строгий фильтр: ${passed.length}`);
    for (const p of passed) console.log(`  ✅ ${p.pair} ${p.branch} M${p.M} tp${p.tp}: train ${p.trainNet}$ test ${p.testNet}$`);

    // леджер гипотез — честность кумулятивна
    const ledgerPath = path.join(process.cwd(), 'data', 'hypothesis-ledger.json');
    if (existsSync(ledgerPath)) {
      const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
      ledger.totalTested += totalCells;
      ledger.batches.push({ id: 'ny-break (идея Димы)', when: new Date().toISOString().slice(0, 10), n: totalCells, stage1: passed.length, stage2: 0, lockboxWins: 0 });
      writeFileSync(ledgerPath, JSON.stringify(ledger, null, 1));
    }

    const outPath = path.join(process.cwd(), 'data', 'ny-break-report.json');
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(report, null, 1));
    console.log(`\nJSON: ${outPath}\nDONE`);
  })().catch(e => {
    console.error(e);
    process.exit(1);
  });
}
