// «Новостной фильтр» для нефти (идея владельца 06.08: Иран/Ормуз качают нефть —
// может, не входить, когда рынок в новостном режиме?).
//
// Календарь не видит геополитику (Иран — не плановый релиз), поэтому детектор —
// градусник самого рынка: часовой диапазон против его скользящей 20-дневной
// медианы. Плюс плановый слот EIA (запасы нефти, среда 14:30/15:30 UTC по DST).
// Новости как СИГНАЛ похоронены слот-стади (направление непредсказуемо) —
// здесь только ФИЛЬТР входов.
//
// Оверлей на tradeList базовой ячейки (как профит-стоп/hot-hand): сделка,
// открытая в заблокированном окне, выбрасывается; net/DD пересчитываются.
// Оговорка та же: оверлей не пересчитывает cooldown/maxConcurrent — первый
// честный фильтр; при победе — полный прогон движковым параметром.
//
// CLI: npx tsx src/backtest/news-guard.ts

import { pathToFileURL } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadM1WithSpread } from './data';
import { BtTrade, MARKETS, prepCandles, runBacktest } from './runner';

interface CellDef {
  key: string;
  market: string;
  params: Record<string, unknown>;
}

// те же ячейки, что в форварде (см. profit-stop.CELLS)
const CELLS: CellDef[] = [
  { key: 'oil-impulse', market: 'lightcmdusd', params: { strategyType: 'impulse', windowSec: 1800, thresholdPips: 6, tpPips: 60, slPips: 120, cooldownSec: 900, spreadGuardPips: 8, maxDailyLossUsd: 20 } },
  { key: 'gold-impulse', market: 'xauusd', params: { strategyType: 'impulse', windowSec: 1800, thresholdPips: 4, tpPips: 20, slPips: 40, cooldownSec: 900, spreadGuardPips: 1.5, maxDailyLossUsd: 10 } },
];

/** Часовой диапазон на каждой минуте + его 20-дневная скользящая медиана
 *  (семпл раз в 15 мин, пересчёт медианы раз в 15 мин — точности хватает). */
function volSeries(candles: Array<{ t: number; h: number; l: number }>, pip: number): { t: number[]; ratio: number[] } {
  const HOUR = 60;
  const t: number[] = [];
  const ratio: number[] = [];
  const samples: number[] = [];
  let med = 0;
  let lastSampleAt = 0;
  let lastMedAt = 0;
  for (let i = 0; i < candles.length; i++) {
    const from = Math.max(0, i - HOUR + 1);
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = from; j <= i; j++) {
      if (candles[j].h > hi) hi = candles[j].h;
      if (candles[j].l < lo) lo = candles[j].l;
    }
    const range = (hi - lo) / pip;
    const ts = candles[i].t;
    if (ts - lastSampleAt >= 15 * 60_000) {
      samples.push(range);
      if (samples.length > 1920) samples.shift(); // 20 дней × 96 семплов
      lastSampleAt = ts;
    }
    if (samples.length >= 100 && ts - lastMedAt >= 15 * 60_000) {
      med = [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)];
      lastMedAt = ts;
    }
    t.push(ts);
    ratio.push(med > 0 ? range / med : 0);
  }
  return { t, ratio };
}

function ratioAt(vs: { t: number[]; ratio: number[] }, ts: number): number {
  // бинарный поиск последней минуты ≤ ts
  let lo = 0;
  let hi = vs.t.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (vs.t[mid] <= ts) lo = mid;
    else hi = mid - 1;
  }
  return vs.ratio[lo] ?? 0;
}

/** Среда, окно вокруг слота EIA (14:30 летом / 15:30 зимой UTC) ± pad мин. */
function inEiaWindow(ts: number, padMin: number): boolean {
  const d = new Date(ts);
  if (d.getUTCDay() !== 3) return false;
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  return (mins >= 870 - padMin && mins <= 870 + padMin) || (mins >= 930 - padMin && mins <= 930 + padMin);
}

interface Res {
  n: number;
  net: number;
  dd: number;
  netPerDd: number;
  testNet: number;
  droppedN: number;
  droppedNet: number;
}

function applyFilter(trades: BtTrade[], blocked: (t: BtTrade) => boolean): Res {
  const sorted = [...trades].sort((a, b) => a.closedAt - b.closedAt);
  const kept = sorted.filter(t => !blocked(t));
  const dropped = sorted.filter(t => blocked(t));
  let cum = 0;
  let peak = 0;
  let dd = 0;
  for (const t of kept) {
    cum += t.pnl;
    peak = Math.max(peak, cum);
    dd = Math.max(dd, peak - cum);
  }
  const cut = Math.floor(kept.length * 0.7);
  return {
    n: kept.length,
    net: +cum.toFixed(2),
    dd: +dd.toFixed(2),
    netPerDd: dd > 0 ? +(cum / dd).toFixed(3) : 0,
    testNet: +kept.slice(cut).reduce((s, t) => s + t.pnl, 0).toFixed(2),
    droppedN: dropped.length,
    droppedNet: +dropped.reduce((s, t) => s + t.pnl, 0).toFixed(2),
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  (async () => {
    const from = new Date('2024-01-01');
    const to = new Date('2026-07-30');
    const report: any = { from, to, cells: [] };

    for (const cell of CELLS) {
      const market = MARKETS[cell.market];
      const raw = await loadM1WithSpread(market.instrument, from, to);
      const candles = prepCandles(raw, market);
      const trades = runBacktest(candles, { ...market.paramsBase, ...cell.params, entryMode: 'limit' }, market, { keepTrades: true }).tradeList ?? [];
      const vs = volSeries(candles, 0.0001);

      const variants: Array<[string, (t: BtTrade) => boolean]> = [
        ['base', () => false],
        ['vol×2', t => ratioAt(vs, t.openedAt) > 2],
        ['vol×3', t => ratioAt(vs, t.openedAt) > 3],
        ['vol×4', t => ratioAt(vs, t.openedAt) > 4],
        ['EIA±30', t => inEiaWindow(t.openedAt, 30)],
        ['EIA±60', t => inEiaWindow(t.openedAt, 60)],
        ['EIA±60 + vol×2', t => inEiaWindow(t.openedAt, 60) || ratioAt(vs, t.openedAt) > 2],
      ];
      console.log(`\n===== ${cell.key} (${trades.length} сделок 2024-01 → 2026-07) =====`);
      const rows: Record<string, Res> = {};
      for (const [name, blocked] of variants) {
        const r = applyFilter(trades, blocked);
        rows[name] = r;
        console.log(
          `  ${name.padEnd(15)}: ${String(r.n).padStart(4)} сд · net ${r.net >= 0 ? '+' : ''}${r.net}$ · DD ${r.dd}$ · net/DD ${r.netPerDd} · test ${r.testNet >= 0 ? '+' : ''}${r.testNet}$`
          + (r.droppedN ? ` · выброшено ${r.droppedN} сд с итогом ${r.droppedNet >= 0 ? '+' : ''}${r.droppedNet}$` : ''),
        );
      }
      report.cells.push({ key: cell.key, trades: trades.length, rows });
    }

    const outPath = path.join(process.cwd(), 'data', 'news-guard-report.json');
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(report, null, 1));
    console.log(`\nJSON: ${outPath}\nDONE`);
  })().catch(e => {
    console.error(e);
    process.exit(1);
  });
}
