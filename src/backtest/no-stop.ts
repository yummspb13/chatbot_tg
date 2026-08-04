// Тест идеи владельца (05.08): «стопы не ставить вообще — ушли в минус, стоим
// и ждём возврата, хоть 3-4 дня». Каждая из 13 walk-forward-ячеек прогоняется
// в двух вариантах:
//   БАЗА    — как есть (обычные SL ячейки);
//   БЕЗ SL  — стоп-лосс отодвинут в бесконечность (SL 100k пипсов, rawParams),
//             тайм-выходов нет: позиция живёт до TP или до конца данных.
//             maxConcurrent=1 сохраняется — висящая позиция блокирует новые
//             входы (честная цена «пересиживания»: упущенные сигналы).
//             Дневной лосс-лимит отключён (без SL он бессмыслен).
//
// Ключевые метрики честности, которые статистика закрытых сделок прячет:
//   MAE — худший ПЛАВАЮЩИЙ минус каждой позиции (сколько «пересиживали»);
//   маркто-DD — просадка кривой капитала С УЧЁТОМ открытого минуса;
//   хвост — максимальная длительность удержания.
//
// CLI: npx tsx src/backtest/no-stop.ts

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

const CELLS: Cell[] = [
  { key: 'eur-meanrev', market: 'eurusd', params: {} },
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

interface Summary {
  n: number;
  net: number;
  wr: number;
  closedDd: number;    // просадка по закрытым сделкам
  worstMaeUsd: number; // худший плавающий минус одной позиции, $
  longestHoldDays: number;
  slCount: number;
}

function summarize(trades: BtTrade[]): Summary {
  const sorted = [...trades].sort((a, b) => a.closedAt - b.closedAt);
  let cum = 0;
  let peak = 0;
  let dd = 0;
  for (const t of sorted) {
    cum += t.pnl;
    peak = Math.max(peak, cum);
    dd = Math.max(dd, peak - cum);
  }
  const worstMae = Math.max(0, ...sorted.map(t => (t.maePips ?? 0)));
  const longest = Math.max(0, ...sorted.map(t => t.closedAt - t.openedAt)) / 86400_000;
  return {
    n: sorted.length,
    net: +cum.toFixed(2),
    wr: sorted.length ? +(sorted.filter(t => t.pnl > 0).length / sorted.length * 100).toFixed(1) : 0,
    closedDd: +dd.toFixed(2),
    worstMaeUsd: +(worstMae * 0.1).toFixed(2), // units=1000 → пипс = $0.10
    longestHoldDays: +longest.toFixed(1),
    slCount: sorted.filter(t => t.reason === 'SL').length,
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  (async () => {
    const from = new Date('2024-01-01');
    const to = new Date('2026-07-30');
    const report: any = { from, to, cells: [] };
    const totals = { base: { net: 0, mae: 0 }, nosl: { net: 0, mae: 0 } };

    for (const cell of CELLS) {
      const market = MARKETS[cell.market];
      const candles = prepCandles(await loadM1WithSpread(market.instrument, from, to), market);
      const base = summarize(
        runBacktest(candles, { ...market.paramsBase, ...cell.params, entryMode: 'limit' }, market, { keepTrades: true }).tradeList ?? [],
      );
      const noSl = summarize(
        runBacktest(candles, {
          ...market.paramsBase, ...cell.params, entryMode: 'limit',
          slPips: 100_000, maxHoldSec: 0, beLockFrac: 0, partialFrac: 0, maxDailyLossUsd: 1e9,
        }, market, { keepTrades: true, rawParams: true }).tradeList ?? [],
      );
      report.cells.push({ key: cell.key, base, noSl });
      totals.base.net += base.net;
      totals.base.mae = Math.max(totals.base.mae, base.worstMaeUsd);
      totals.nosl.net += noSl.net;
      totals.nosl.mae = Math.max(totals.nosl.mae, noSl.worstMaeUsd);
      console.log(`${cell.key.padEnd(13)} база:  net ${base.net}$ · wr ${base.wr}% · ${base.n} сд · DD(закр) ${base.closedDd}$ · worst-MAE ${base.worstMaeUsd}$ · SL ${base.slCount}`);
      console.log(`${''.padEnd(13)} безSL: net ${noSl.net}$ · wr ${noSl.wr}% · ${noSl.n} сд · DD(закр) ${noSl.closedDd}$ · worst-MAE ${noSl.worstMaeUsd}$ · макс. удержание ${noSl.longestHoldDays}д`);
    }

    console.log('\n===== ПОРТФЕЛЬ (13 ячеек) =====');
    console.log(`  база:   net ${totals.base.net.toFixed(2)}$ · worst-MAE ${totals.base.mae}$`);
    console.log(`  без SL: net ${totals.nosl.net.toFixed(2)}$ · worst-MAE ${totals.nosl.mae}$`);

    const outPath = path.join(process.cwd(), 'data', 'no-stop-report.json');
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(report, null, 1));
    console.log(`\nJSON: ${outPath}\nDONE`);
  })().catch(e => {
    console.error(e);
    process.exit(1);
  });
}
