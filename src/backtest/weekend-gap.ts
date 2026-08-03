// Гэп выходных: закрытие пятницы vs открытие воскресенья — и «BTC знает про
// понедельник».
//
// Часть A (измерение): размер гэпа по рынкам, доля закрытия гэпа до пн 21:00,
// реальный спред воскресного открытия (наш давний калиброванный «злой» спред).
//
// Часть B (правила, walk-forward 70/30 по уикендам + Бонферрони):
//   fade-fill  — против гэпа, TP = цена закрытия пятницы (полное закрытие гэпа),
//                SL = 1×|гэп| дальше, тайм-выход пн 21:00;
//   fade-fixed — против гэпа, фиксированные TP/SL (20/40 ×mult);
//   follow-fixed — по гэпу (моментум разрыва), фиксированные TP/SL.
// Вход всегда РЫНОЧНЫЙ на первой воскресной минутке — платим её реальный
// полуспред (Sunday-open спред у нас в данных настоящий, это половина честности
// всего теста).
//
// Часть B2 (авторская): пока FX спал, BTC торговал — знак уикенд-хода BTC
// (пт 21:00 → вс 21:00) как направление входа на воскресном открытии золота,
// S&P и GBPJPY. Мало кто может это проверить — у нас обе стороны в кэше.
//
// CLI: npx tsx src/backtest/weekend-gap.ts [--from 2024-01-01] [--to 2026-07-30]

import { pathToFileURL } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PIP } from '../broker/types';
import { Candle, loadM1WithSpread } from './data';
import { MARKETS, prepCandles } from './runner';

// ---------------------------------------------------------------- утилиты (как в news-slots)

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

interface Book {
  candles: Candle[];
  idxAtOrBefore: (t: number) => number;
}

function makeBook(candles: Candle[]): Book {
  const ts = candles.map(c => c.t);
  return {
    candles,
    idxAtOrBefore(t: number): number {
      let lo = 0;
      let hi = ts.length - 1;
      if (!ts.length || t < ts[0]) return -1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (ts[mid] <= t) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    },
  };
}

// ---------------------------------------------------------------- уикенды

interface Weekend {
  friClose21: number;  // UTC ms пятницы 21:00
  sunOpen21: number;   // UTC ms воскресенья 21:00
  monClose21: number;  // UTC ms понедельника 21:00 (дедлайн)
}

function buildWeekends(from: Date, to: Date): Weekend[] {
  const out: Weekend[] = [];
  const d = new Date(from.getTime());
  while (d.getTime() < to.getTime()) {
    if (d.getUTCDay() === 5) {
      const fri = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 21);
      out.push({ friClose21: fri, sunOpen21: fri + 2 * 86400_000, monClose21: fri + 3 * 86400_000 });
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out.filter(w => w.monClose21 < to.getTime());
}

/** Пятничный якорь и воскресный первый бар (в пределах 3ч от 21:00). */
function anchors(book: Book, w: Weekend): { friIdx: number; sunIdx: number } | null {
  const friIdx = book.idxAtOrBefore(w.friClose21);
  if (friIdx < 0 || w.friClose21 - book.candles[friIdx].t > 3 * 3600_000) return null;
  let sunIdx = book.idxAtOrBefore(w.sunOpen21);
  // первый бар ПОСЛЕ 21:00 вс: idxAtOrBefore даёт пятничный — шагаем вперёд
  while (sunIdx >= 0 && sunIdx < book.candles.length && book.candles[sunIdx].t < w.sunOpen21) sunIdx += 1;
  if (sunIdx < 0 || sunIdx >= book.candles.length) return null;
  if (book.candles[sunIdx].t - w.sunOpen21 > 3 * 3600_000) return null; // рынок не открылся в окно
  return { friIdx, sunIdx };
}

// ---------------------------------------------------------------- сделка от воскресного открытия

interface GapTrade {
  pnlUsd: number;
  reason: string;
}

function runFromSundayOpen(
  book: Book,
  sunIdx: number,
  side: 'BUY' | 'SELL',
  tpPrice: number,
  slPrice: number,
  deadline: number,
): GapTrade {
  const c0 = book.candles[sunIdx];
  const half0 = (c0.sp ?? PIP) / 2;
  const entry = side === 'BUY' ? c0.c + half0 : c0.c - half0; // рыночный вход, реальный воскресный спред
  for (let i = sunIdx + 1; i < book.candles.length; i++) {
    const c = book.candles[i];
    const half = (c.sp ?? PIP) / 2;
    if (side === 'BUY') {
      if (c.l - half <= slPrice) return { pnlUsd: (slPrice - entry) * 1000, reason: 'SL' };
      if (c.h - half >= tpPrice) return { pnlUsd: (tpPrice - entry) * 1000, reason: 'TP' };
    } else {
      if (c.h + half >= slPrice) return { pnlUsd: (entry - slPrice) * 1000, reason: 'SL' };
      if (c.l + half <= tpPrice) return { pnlUsd: (entry - tpPrice) * 1000, reason: 'TP' };
    }
    if (c.t >= deadline) {
      const exit = side === 'BUY' ? c.c - half : c.c + half;
      return { pnlUsd: (side === 'BUY' ? exit - entry : entry - exit) * 1000, reason: 'TIME' };
    }
  }
  const last = book.candles[book.candles.length - 1];
  const half = (last.sp ?? PIP) / 2;
  const exit = side === 'BUY' ? last.c - half : last.c + half;
  return { pnlUsd: (side === 'BUY' ? exit - entry : entry - exit) * 1000, reason: 'EOD' };
}

// ---------------------------------------------------------------- главный прогон

function parseArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

const GAP_MARKETS = ['eurusd', 'xauusd', 'gbpjpy', 'usa500idxusd', 'lightcmdusd'];
const BTC_TARGETS = ['xauusd', 'usa500idxusd', 'gbpjpy'];

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  (async () => {
    const from = new Date(parseArg('from') ?? '2024-01-01');
    const to = new Date(parseArg('to') ?? '2026-07-30');
    const weekends = buildWeekends(from, to);
    console.log(`Уикендов в окне: ${weekends.length} (${from.toISOString().slice(0, 10)} → ${to.toISOString().slice(0, 10)})`);

    const totalCells = GAP_MARKETS.length * 3 + BTC_TARGETS.length;
    const zBonf = normalQuantile(1 - (0.05 / totalCells) / 2);
    console.log(`Ячеек: ${totalCells} → Бонферрони порог |t|≥${zBonf.toFixed(2)}\n`);

    // BTC-уикенд-ход (для части B2): пт 21:00 → вс 21:00, в масштабе BTC (÷100k)
    const btcMarket = MARKETS.btcusd;
    const btcBook = makeBook(prepCandles(await loadM1WithSpread(btcMarket.instrument, from, to), btcMarket));
    const btcMove = new Map<number, number>(); // friClose21 → ход в scaled-пипсах
    for (const w of weekends) {
      const i0 = btcBook.idxAtOrBefore(w.friClose21);
      const i1 = btcBook.idxAtOrBefore(w.sunOpen21);
      if (i0 < 0 || i1 <= i0) continue;
      btcMove.set(w.friClose21, (btcBook.candles[i1].c - btcBook.candles[i0].c) / PIP);
    }
    console.log(`BTC-уикенд-ходы посчитаны: ${btcMove.size} (медиана |хода| ${
      [...btcMove.values()].map(Math.abs).sort((a, b) => a - b)[Math.floor(btcMove.size / 2)]?.toFixed(0)}п масштаба BTC)\n`);

    const report: any = { from, to, zBonf, weekends: weekends.length, cells: [], measure: {} };

    for (const pair of GAP_MARKETS) {
      const market = MARKETS[pair];
      const mult = market.pipsMult ?? 1;
      const book = makeBook(prepCandles(await loadM1WithSpread(market.instrument, from, to), market));

      // ---- часть A: измерение гэпов
      let n = 0;
      let filled = 0;
      const gapsAbs: number[] = [];
      const sunSpreads: number[] = [];
      const events: Array<{ w: Weekend; friIdx: number; sunIdx: number; gap: number }> = [];
      for (const w of weekends) {
        const a = anchors(book, w);
        if (!a) continue;
        const friClose = book.candles[a.friIdx].c;
        const sunOpen = book.candles[a.sunIdx].c;
        const gap = sunOpen - friClose;
        n += 1;
        gapsAbs.push(Math.abs(gap) / (mult * PIP));
        const sp = book.candles[a.sunIdx].sp;
        if (sp !== undefined) sunSpreads.push(sp / PIP);
        // закрылся ли гэп до пн 21:00 (касание пятничного закрытия)
        let hit = false;
        for (let i = a.sunIdx + 1; i < book.candles.length && book.candles[i].t < w.monClose21; i++) {
          if (gap > 0 ? book.candles[i].l <= friClose : book.candles[i].h >= friClose) {
            hit = true;
            break;
          }
        }
        if (hit) filled += 1;
        if (Math.abs(gap) >= 2 * mult * PIP) events.push({ w, friIdx: a.friIdx, sunIdx: a.sunIdx, gap });
      }
      const avg = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
      report.measure[pair] = {
        weekends: n,
        meanAbsGapPips: +avg(gapsAbs).toFixed(1),
        fillRate: n ? +(filled / n).toFixed(2) : 0,
        sundayOpenSpreadPips: +avg(sunSpreads).toFixed(2),
        tradableGaps: events.length,
      };
      console.log(`===== ${pair}: уикендов ${n}, |гэп| ср ${report.measure[pair].meanAbsGapPips}п(×${mult}), `
        + `закрытие гэпа до пн: ${(report.measure[pair].fillRate * 100).toFixed(0)}%, `
        + `спред вс-открытия ${report.measure[pair].sundayOpenSpreadPips}п, торгуемых (|гэп|≥2×mult): ${events.length}`);

      // ---- часть B: три правила
      const rules = [
        { key: 'fade-fill', mk: (e: typeof events[0]) => {
          const friClose = book.candles[e.friIdx].c;
          const side: 'BUY' | 'SELL' = e.gap > 0 ? 'SELL' : 'BUY';
          const entryMid = book.candles[e.sunIdx].c;
          const sl = side === 'SELL' ? entryMid + Math.abs(e.gap) : entryMid - Math.abs(e.gap);
          return { side, tp: friClose, sl };
        } },
        { key: 'fade-fixed', mk: (e: typeof events[0]) => {
          const side: 'BUY' | 'SELL' = e.gap > 0 ? 'SELL' : 'BUY';
          const m = book.candles[e.sunIdx].c;
          return side === 'SELL'
            ? { side, tp: m - 20 * mult * PIP, sl: m + 40 * mult * PIP }
            : { side, tp: m + 20 * mult * PIP, sl: m - 40 * mult * PIP };
        } },
        { key: 'follow-fixed', mk: (e: typeof events[0]) => {
          const side: 'BUY' | 'SELL' = e.gap > 0 ? 'BUY' : 'SELL';
          const m = book.candles[e.sunIdx].c;
          return side === 'BUY'
            ? { side, tp: m + 20 * mult * PIP, sl: m - 40 * mult * PIP }
            : { side, tp: m - 20 * mult * PIP, sl: m + 40 * mult * PIP };
        } },
      ];
      for (const rule of rules) {
        const pnls: number[] = [];
        for (const e of events) {
          const { side, tp, sl } = rule.mk(e);
          pnls.push(runFromSundayOpen(book, e.sunIdx, side, tp, sl, e.w.monClose21).pnlUsd);
        }
        if (pnls.length < 20) continue;
        const cut = Math.floor(pnls.length * 0.7);
        const train = pnls.slice(0, cut);
        const test = pnls.slice(cut);
        const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
        const cell = {
          pair, rule: rule.key, n: pnls.length,
          trainNet: +sum(train).toFixed(2), trainT: +tStat(train).toFixed(2),
          testNet: +sum(test).toFixed(2), testN: test.length,
          pass: sum(train) > 0 && Math.abs(tStat(train)) >= zBonf && sum(test) > 0,
        };
        report.cells.push(cell);
        const mark = cell.pass ? '✅ ПРОШЛА' : cell.trainNet > 0 && cell.testNet > 0 ? '· обе половины в плюсе (t мал)' : '  ';
        console.log(`  ${mark} ${rule.key}: train ${cell.trainNet}$ (t=${cell.trainT}, n=${train.length}) · test ${cell.testNet}$ (n=${test.length})`);
      }

      // ---- часть B2: направление от BTC-уикенда
      if (BTC_TARGETS.includes(pair)) {
        const pnls: number[] = [];
        let agree = 0;
        let cnt = 0;
        for (const w of weekends) {
          const a = anchors(book, w);
          const mv = btcMove.get(w.friClose21);
          if (!a || mv === undefined || Math.abs(mv) < 40) continue; // BTC-уикенд без внятного хода — пропуск
          const gap = book.candles[a.sunIdx].c - book.candles[a.friIdx].c;
          cnt += 1;
          if (Math.sign(gap) === Math.sign(mv)) agree += 1;
          const side: 'BUY' | 'SELL' = mv > 0 ? 'BUY' : 'SELL';
          const m = book.candles[a.sunIdx].c;
          const { tp, sl } = side === 'BUY'
            ? { tp: m + 20 * mult * PIP, sl: m - 40 * mult * PIP }
            : { tp: m - 20 * mult * PIP, sl: m + 40 * mult * PIP };
          pnls.push(runFromSundayOpen(book, a.sunIdx, side, tp, sl, w.monClose21).pnlUsd);
        }
        if (pnls.length >= 20) {
          const cut = Math.floor(pnls.length * 0.7);
          const train = pnls.slice(0, cut);
          const test = pnls.slice(cut);
          const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
          const cell = {
            pair, rule: 'btc-follow', n: pnls.length,
            gapSignAgree: cnt ? +(agree / cnt).toFixed(2) : 0,
            trainNet: +sum(train).toFixed(2), trainT: +tStat(train).toFixed(2),
            testNet: +sum(test).toFixed(2), testN: test.length,
            pass: sum(train) > 0 && Math.abs(tStat(train)) >= zBonf && sum(test) > 0,
          };
          report.cells.push(cell);
          console.log(`  ${cell.pass ? '✅ ПРОШЛА' : '  '} btc-follow: совпадение знака гэпа с BTC ${(cell.gapSignAgree * 100).toFixed(0)}% · `
            + `train ${cell.trainNet}$ (t=${cell.trainT}) · test ${cell.testNet}$ (n=${test.length})`);
        }
      }
      console.log('');
    }

    const passed = report.cells.filter((c: any) => c.pass);
    console.log(`ИТОГ: ячеек ${report.cells.length}, прошли строгий фильтр: ${passed.length}`);
    for (const p of passed) console.log(`  ✅ ${p.pair} × ${p.rule}: train ${p.trainNet}$ (t=${p.trainT}) test ${p.testNet}$`);

    const outPath = path.join(process.cwd(), 'data', 'weekend-gap-report.json');
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(report, null, 1));
    console.log(`\nJSON: ${outPath}\nDONE`);
  })().catch(e => {
    console.error(e);
    process.exit(1);
  });
}
