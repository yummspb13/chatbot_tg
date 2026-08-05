// «Hot-hand» — эскалация размера за серией побед (идея владельца 05.08):
//   внутри дня: 3 плюса → размер ×3, ещё 2 плюса (5 всего) → ×5, сброс к утру;
//   плюс вариант «вчера в плюсе → сегодня ×2» (и ×10 — для наглядности амплитуды).
//
// Оверлей ТОЛЬКО масштабирует pnl сделок (последовательность не меняется —
// какие сделки взяты, решает стратегия; вопрос лишь «каким размером»).
// Множитель сделки определяется в момент её ОТКРЫТИЯ по уже закрытым сделкам.
// Гипотеза, которую это проверяет напрямую: кластеризуются ли ПОБЕДЫ внутри дня
// (положительная автокорреляция исходов). Если нет — множитель умножает шум.
//
// Честная метрика сравнения — не net (он растёт от любого увеличения среднего
// размера при положительном крае), а НЕТ/DD: доход на единицу риска.
// Варианты: base ×1 · ladder-cum (3 плюса всего→×3, 5→×5) ·
// ladder-streak (3 ПОДРЯД→×3, 5 подряд→×5, минус сбрасывает) ·
// yday×2 · yday×10.
//
// CLI: npx tsx src/backtest/hot-hand.ts

import { pathToFileURL } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadM1WithSpread } from './data';
import { BtTrade, MARKETS, prepCandles, runBacktest } from './runner';
import { CELLS } from './profit-stop';

type Variant = 'base' | 'ladder-cum' | 'ladder-streak' | 'yday×2' | 'yday×10';
const VARIANTS: Variant[] = ['base', 'ladder-cum', 'ladder-streak', 'yday×2', 'yday×10'];

interface Res {
  net: number;
  testNet: number;
  dd: number;
  netPerDd: number;
  boosted: number; // сделок повышенным размером
}

function overlay(trades: BtTrade[], variant: Variant): Res {
  const sorted = [...trades].sort((a, b) => a.openedAt - b.openedAt);
  // дневной агрегат для вариантов «вчера»
  const dayNet = new Map<string, number>();
  for (const t of sorted) {
    const d = new Date(t.closedAt).toISOString().slice(0, 10);
    dayNet.set(d, (dayNet.get(d) ?? 0) + t.pnl);
  }
  const prevDayOf = (day: string): string | null => {
    // ближайший предыдущий торговый день из имеющихся
    const days = [...dayNet.keys()].sort();
    const i = days.indexOf(day);
    return i > 0 ? days[i - 1] : null;
  };

  const scaled: Array<{ t: BtTrade; mult: number }> = [];
  const byDay = new Map<string, BtTrade[]>();
  for (const t of sorted) {
    const d = new Date(t.openedAt).toISOString().slice(0, 10);
    (byDay.get(d) ?? byDay.set(d, []).get(d)!).push(t);
  }
  for (const [day, list] of byDay) {
    let ydayMult = 1;
    if (variant === 'yday×2' || variant === 'yday×10') {
      const prev = prevDayOf(day);
      const prevNet = prev ? dayNet.get(prev) ?? 0 : 0;
      ydayMult = prevNet > 0 ? (variant === 'yday×2' ? 2 : 10) : 1;
    }
    const closes: Array<{ at: number; pnl: number }> = [];
    for (const t of list) {
      let mult = 1;
      if (variant === 'yday×2' || variant === 'yday×10') {
        mult = ydayMult;
      } else if (variant === 'ladder-cum' || variant === 'ladder-streak') {
        const done = closes.filter(c => c.at <= t.openedAt);
        let wins = 0;
        if (variant === 'ladder-cum') {
          wins = done.filter(c => c.pnl > 0).length;
        } else {
          for (let i = done.length - 1; i >= 0; i--) {
            if (done[i].pnl > 0) wins += 1;
            else break;
          }
        }
        mult = wins >= 5 ? 5 : wins >= 3 ? 3 : 1;
      }
      scaled.push({ t, mult });
      closes.push({ at: t.closedAt, pnl: t.pnl });
    }
  }

  scaled.sort((a, b) => a.t.closedAt - b.t.closedAt);
  let cum = 0;
  let peak = 0;
  let dd = 0;
  for (const s of scaled) {
    cum += s.t.pnl * s.mult;
    peak = Math.max(peak, cum);
    dd = Math.max(dd, peak - cum);
  }
  const cut = Math.floor(scaled.length * 0.7);
  const testNet = scaled.slice(cut).reduce((s, x) => s + x.t.pnl * x.mult, 0);
  return {
    net: +cum.toFixed(2),
    testNet: +testNet.toFixed(2),
    dd: +dd.toFixed(2),
    netPerDd: dd > 0 ? +(cum / dd).toFixed(3) : 0,
    boosted: scaled.filter(s => s.mult > 1).length,
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  (async () => {
    const from = new Date('2024-01-01');
    const to = new Date('2026-07-30');
    const report: any = { from, to, variants: VARIANTS, cells: [] };
    const portfolio = new Map<Variant, { net: number; dd: number }>();

    for (const cell of CELLS) {
      const market = MARKETS[cell.market];
      const candles = prepCandles(await loadM1WithSpread(market.instrument, from, to), market);
      const trades = runBacktest(candles, { ...market.paramsBase, ...cell.params, entryMode: 'limit' }, market, { keepTrades: true }).tradeList ?? [];
      const rows: Record<string, Res> = {};
      for (const v of VARIANTS) {
        const r = overlay(trades, v);
        rows[v] = r;
        const p = portfolio.get(v) ?? { net: 0, dd: 0 };
        p.net += r.net;
        p.dd += r.dd;
        portfolio.set(v, p);
      }
      report.cells.push({ key: cell.key, trades: trades.length, rows });
      const b = rows.base;
      console.log(`${cell.key.padEnd(13)} (${trades.length} сд): base net ${b.net}$ · DD ${b.dd}$ · net/DD ${b.netPerDd}`);
      for (const v of VARIANTS.slice(1)) {
        const r = rows[v];
        console.log(`   ${v.padEnd(13)}: net ${r.net}$ · test ${r.testNet}$ · DD ${r.dd}$ · net/DD ${r.netPerDd} · буст ${r.boosted} сд`);
      }
    }

    console.log('\n===== ПОРТФЕЛЬ (13 ячеек, сумма) =====');
    const base = portfolio.get('base')!;
    for (const [v, p] of portfolio) {
      const ratio = p.dd > 0 ? (p.net / p.dd).toFixed(3) : '—';
      console.log(`  ${v.padEnd(13)}: net ${p.net.toFixed(2)}$ · ΣDD ${p.dd.toFixed(2)}$ · net/ΣDD ${ratio}${v === 'base' ? ' ← эталон' : ''}`);
    }
    void base;

    const outPath = path.join(process.cwd(), 'data', 'hot-hand-report.json');
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(report, null, 1));
    console.log(`\nJSON: ${outPath}\nDONE`);
  })().catch(e => {
    console.error(e);
    process.exit(1);
  });
}
