// Дневной ПРОФИТ-стоп (идея владельца 05.08): «сделали дневную цель — стоп до
// завтра». Проверяем на 13 walk-forward-выживших ячейках портфеля: помогает ли
// кривой капитала остановка после +X$ за день, или она обрезает жирные хвосты
// трендовых дней, которые кормят месяц.
//
// Механика честная: бэктест ячейки прогоняется КАК ЕСТЬ (с её дневным
// лосс-лимитом), затем поверх списка сделок накладывается оверлей: сделка,
// ОТКРЫТАЯ после момента, когда реализованный PnL дня достиг +X$, отбрасывается
// (= «новых входов после цели не открываем»; уже открытые дорабатывают).
// Сетка X: 2$ / 5$ / 10$ на ячейку (при нашем юнит-размере это ~0.5-2.5%
// дневного хода депозита микро-масштаба) против базы без стопа.
//
// CLI: npx tsx src/backtest/profit-stop.ts

import { pathToFileURL } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AgentParams } from '../agent/params';
import { loadM1WithSpread } from './data';
import { BtTrade, MARKETS, prepCandles, runBacktest } from './runner';

interface Cell {
  key: string;
  market: string;
  params: Partial<AgentParams>;
}

// 13 выживших walk-forward ячеек — параметры из виртуальных ростеров
const CELLS: Cell[] = [
  { key: 'eur-meanrev', market: 'eurusd', params: {} }, // live-пресет = DEFAULT_PARAMS
  { key: 'gj-meanrev', market: 'gbpjpy', params: { windowSec: 1800, thresholdPips: 16, tpPips: 12, slPips: 40, cooldownSec: 900, spreadGuardPips: 6, maxDailyLossUsd: 10 } },
  { key: 'gj-vprofile', market: 'gbpjpy', params: { strategyType: 'vprofile', windowSec: 7200, thresholdPips: 6, tpPips: 30, slPips: 50, cooldownSec: 1800, spreadGuardPips: 6, maxDailyLossUsd: 10 } },
  { key: 'gold-impulse', market: 'xauusd', params: { strategyType: 'impulse', windowSec: 1800, thresholdPips: 4, tpPips: 20, slPips: 40, cooldownSec: 900, spreadGuardPips: 1.5, maxDailyLossUsd: 10 } },
  { key: 'oil-impulse', market: 'lightcmdusd', params: { strategyType: 'impulse', windowSec: 1800, thresholdPips: 6, tpPips: 60, slPips: 120, cooldownSec: 900, spreadGuardPips: 8, maxDailyLossUsd: 20 } },
  { key: 'sp-matrend', market: 'usa500idxusd', params: { strategyType: 'matrend', windowSec: 14400, thresholdPips: 12, tpPips: 30, slPips: 40, cooldownSec: 1800, spreadGuardPips: 2, maxDailyLossUsd: 10 } },
  { key: 'btc-matrend', market: 'btcusd', params: { strategyType: 'matrend', windowSec: 7200, thresholdPips: 12, tpPips: 100, slPips: 80, cooldownSec: 1800, spreadGuardPips: 5, maxDailyLossUsd: 20, newsBufferMin: 0 } },
  { key: 'btc-vprofile', market: 'btcusd', params: { strategyType: 'vprofile', windowSec: 7200, thresholdPips: 12, tpPips: 100, slPips: 60, cooldownSec: 1800, spreadGuardPips: 5, maxDailyLossUsd: 20, newsBufferMin: 0 } },
  { key: 'gn-echo', market: 'gbpnzd', params: { strategyType: 'echo', windowSec: 3600, thresholdPips: 60, tpPips: 72, slPips: 120, cooldownSec: 1800, spreadGuardPips: 8, maxDailyLossUsd: 15 } },
  { key: 'gn-meanrev', market: 'gbpnzd', params: { windowSec: 3600, thresholdPips: 48, tpPips: 60, slPips: 120, cooldownSec: 900, spreadGuardPips: 8, maxDailyLossUsd: 15 } },
  { key: 'ej-echo', market: 'eurjpy', params: { strategyType: 'echo', windowSec: 3600, thresholdPips: 80, tpPips: 48, slPips: 80, cooldownSec: 1800, spreadGuardPips: 5, maxDailyLossUsd: 10 } },
  { key: 'aj-momentum', market: 'audjpy', params: { strategyType: 'momentum', windowSec: 300, thresholdPips: 15, tpPips: 60, slPips: 60, cooldownSec: 300, spreadGuardPips: 4, maxDailyLossUsd: 10 } },
  { key: 'jp-vprofile', market: 'jp225', params: { strategyType: 'vprofile', windowSec: 7200, thresholdPips: 60, tpPips: 150, slPips: 150, cooldownSec: 1800, spreadGuardPips: 3, maxDailyLossUsd: 15 } },
];

const STOPS: Array<number | null> = [null, 2, 5, 10];

interface OverlayResult {
  net: number;
  testNet: number;
  dd: number;
  taken: number;
  skipped: number;
  stopDays: number;
}

/** Оверлей: выбросить сделки, открытые после достижения дневной цели. */
function applyProfitStop(trades: BtTrade[], stop: number | null): OverlayResult {
  const sorted = [...trades].sort((a, b) => a.openedAt - b.openedAt);
  const taken: BtTrade[] = [];
  let skipped = 0;
  const stopDaysSet = new Set<string>();
  if (stop === null) {
    taken.push(...sorted);
  } else {
    // по дням: реализованный PnL дня на момент ОТКРЫТИЯ кандидата
    const byDay = new Map<string, BtTrade[]>();
    for (const t of sorted) {
      const day = new Date(t.openedAt).toISOString().slice(0, 10);
      (byDay.get(day) ?? byDay.set(day, []).get(day)!).push(t);
    }
    for (const [day, list] of byDay) {
      const closes: Array<{ at: number; pnl: number }> = [];
      for (const t of list) {
        const realized = closes.filter(c => c.at <= t.openedAt).reduce((s, c) => s + c.pnl, 0);
        if (realized >= stop) {
          skipped += 1;
          stopDaysSet.add(day);
          continue;
        }
        taken.push(t);
        closes.push({ at: t.closedAt, pnl: t.pnl });
      }
    }
  }
  taken.sort((a, b) => a.closedAt - b.closedAt);
  let cum = 0;
  let peak = 0;
  let dd = 0;
  for (const t of taken) {
    cum += t.pnl;
    peak = Math.max(peak, cum);
    dd = Math.max(dd, peak - cum);
  }
  const cut = Math.floor(taken.length * 0.7);
  const testNet = taken.slice(cut).reduce((s, t) => s + t.pnl, 0);
  return {
    net: +cum.toFixed(2),
    testNet: +testNet.toFixed(2),
    dd: +dd.toFixed(2),
    taken: taken.length,
    skipped,
    stopDays: stopDaysSet.size,
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  (async () => {
    const from = new Date('2024-01-01');
    const to = new Date('2026-07-30');
    const report: any = { from, to, stops: STOPS, cells: [] };
    const portfolio = new Map<string, { net: number; dd: number }>();

    for (const cell of CELLS) {
      const market = MARKETS[cell.market];
      const candles = prepCandles(await loadM1WithSpread(market.instrument, from, to), market);
      const bt = runBacktest(candles, { ...market.paramsBase, ...cell.params, entryMode: 'limit' }, market, { keepTrades: true });
      const trades = bt.tradeList ?? [];
      const rows: Record<string, OverlayResult> = {};
      for (const stop of STOPS) {
        const r = applyProfitStop(trades, stop);
        const k = stop === null ? 'без стопа' : `+${stop}$/д`;
        rows[k] = r;
        const p = portfolio.get(k) ?? { net: 0, dd: 0 };
        p.net += r.net;
        p.dd += r.dd;
        portfolio.set(k, p);
      }
      report.cells.push({ key: cell.key, market: cell.market, trades: trades.length, rows });
      const base = rows['без стопа'];
      console.log(`${cell.key.padEnd(13)} (${trades.length} сд): без стопа net ${base.net}$ (test ${base.testNet}$, DD ${base.dd}$)`);
      for (const stop of STOPS.slice(1)) {
        const k = `+${stop}$/д`;
        const r = rows[k];
        const dNet = +(r.net - base.net).toFixed(2);
        console.log(`   ${k.padEnd(7)}: net ${r.net}$ (Δ ${dNet >= 0 ? '+' : ''}${dNet}$) · test ${r.testNet}$ · DD ${r.dd}$ · стоп-дней ${r.stopDays} · пропущено ${r.skipped} сд`);
      }
    }

    console.log('\n===== ПОРТФЕЛЬ (сумма 13 ячеек) =====');
    for (const [k, p] of portfolio) {
      console.log(`  ${k.padEnd(9)}: net ${p.net.toFixed(2)}$ · сумма DD ${p.dd.toFixed(2)}$`);
    }

    const outPath = path.join(process.cwd(), 'data', 'profit-stop-report.json');
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(report, null, 1));
    console.log(`\nJSON: ${outPath}\nDONE`);
  })().catch(e => {
    console.error(e);
    process.exit(1);
  });
}
