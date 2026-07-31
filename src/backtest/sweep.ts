// Мультипарный research-конвейер: пары × стратегии × режимы входа,
// каждая ячейка — walk-forward (подбор на train 70%, честная оценка на test 30%).
// Итог — ранжированная таблица: что (если вообще что-то) выживает после издержек.
//
// CLI: npm run sweep -- --from 2024-01-01 --to 2026-07-30
//      npm run sweep -- --pairs btcusd,ethusd            # крипта (24/7, с выходными)

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadM1 } from './data';
import { BtReport, gridFor, MARKETS, optimize, prepCandles } from './runner';
import type { AgentParams, EntryMode, StrategyType } from '../agent/params';

const DEFAULT_PAIRS = ['eurusd', 'gbpusd', 'audusd', 'nzdusd'];
const STRATS: StrategyType[] = ['momentum', 'meanrev', 'impulse', 'echo'];
const MODES: EntryMode[] = ['market', 'limit'];

export interface SweepRow {
  pair: string;
  strategy: StrategyType;
  entryMode: EntryMode;
  bestParams: Partial<AgentParams> | null;
  trainNet: number | null;
  test: null | {
    netUsd: number;
    trades: number;
    winRate: number;
    expectancyUsd: number;
    spreadCostUsd: number;
    maxDrawdownUsd: number;
    unfilledEntries: number;
    tradesPerWeek: number;
    weekendTrades: number; // сделки, открытые в сб/вс UTC (крипта)
    weekendNetUsd: number;
  };
}

function toRow(pair: string, strategy: StrategyType, entryMode: EntryMode, best: { params: Partial<AgentParams>; train: BtReport; test: BtReport } | null): SweepRow {
  if (!best) return { pair, strategy, entryMode, bestParams: null, trainNet: null, test: null };
  const wknd = best.test.byDow.filter(d => d.dow === 0 || d.dow === 6);
  return {
    pair,
    strategy,
    entryMode,
    bestParams: best.params,
    trainNet: best.train.netUsd,
    test: {
      netUsd: best.test.netUsd,
      trades: best.test.trades,
      winRate: best.test.winRate,
      expectancyUsd: best.test.expectancyUsd,
      spreadCostUsd: best.test.spreadCostUsd,
      maxDrawdownUsd: best.test.maxDrawdownUsd,
      unfilledEntries: best.test.unfilledEntries,
      tradesPerWeek: best.test.tradesPerWeek,
      weekendTrades: wknd.reduce((s, d) => s + d.n, 0),
      weekendNetUsd: wknd.reduce((s, d) => s + d.netUsd, 0),
    },
  };
}

function parseArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

export async function runSweep(from: Date, to: Date, pairs: string[] = DEFAULT_PAIRS): Promise<SweepRow[]> {
  const rows: SweepRow[] = [];
  for (const pair of pairs) {
    const market = MARKETS[pair];
    if (!market) {
      console.warn(`${pair}: неизвестный рынок, пропуск (есть: ${Object.keys(MARKETS).join(', ')})`);
      continue;
    }
    const candles = prepCandles(await loadM1(market.instrument, from, to), market);
    if (candles.length < 50_000) {
      console.warn(`${pair}: мало данных (${candles.length}), пропуск`);
      continue;
    }
    for (const strategy of STRATS) {
      for (const entryMode of MODES) {
        const started = Date.now();
        const opt = optimize(candles, gridFor(strategy, entryMode, 1000, market.pipsMult ?? 1, market.paramsBase), market, 0.7);
        rows.push(toRow(pair, strategy, entryMode, opt.best));
        const r = rows[rows.length - 1];
        console.log(
          `${pair} ${strategy}/${entryMode}: `
          + (r.test
            ? `test ${r.test.netUsd >= 0 ? '+' : ''}${r.test.netUsd.toFixed(2)}$ (${r.test.trades} сд, wr ${(r.test.winRate * 100).toFixed(1)}%)`
            : 'нет валидных комбинаций')
          + ` [${Math.round((Date.now() - started) / 1000)}с]`,
        );
      }
    }
  }
  rows.sort((a, b) => (b.test?.netUsd ?? -Infinity) - (a.test?.netUsd ?? -Infinity));
  return rows;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  (async () => {
    const from = new Date(parseArg('from') ?? '2024-01-01');
    const to = new Date(parseArg('to') ?? new Date().toISOString().slice(0, 10));
    const pairs = (parseArg('pairs')?.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)) ?? DEFAULT_PAIRS;
    console.log(`Sweep: ${pairs.join(', ')} × ${STRATS.join('/')} × ${MODES.join('/')}\n`);
    const rows = await runSweep(from, to, pairs);

    console.log('\n=== ИТОГ (сортировка по test net) ===');
    for (const r of rows) {
      if (!r.test) {
        console.log(`${r.pair} ${r.strategy}/${r.entryMode}: —`);
        continue;
      }
      console.log(
        `${r.pair.padEnd(7)} ${r.strategy.padEnd(8)} ${r.entryMode.padEnd(6)} `
        + `test ${(r.test.netUsd >= 0 ? '+' : '') + r.test.netUsd.toFixed(2)}$`.padEnd(14)
        + ` ожид ${(r.test.expectancyUsd >= 0 ? '+' : '') + r.test.expectancyUsd.toFixed(3)}$/сд`
        + ` · ${r.test.trades} сд (~${r.test.tradesPerWeek.toFixed(1)}/нед) · wr ${(r.test.winRate * 100).toFixed(1)}%`
        + ` · спред ${r.test.spreadCostUsd.toFixed(2)}$ · DD ${r.test.maxDrawdownUsd.toFixed(2)}$`
        + (r.entryMode === 'limit' ? ` · неисполнено ${r.test.unfilledEntries}` : '')
        + (r.test.weekendTrades > 0 ? ` · вых ${r.test.weekendTrades}сд ${(r.test.weekendNetUsd >= 0 ? '+' : '') + r.test.weekendNetUsd.toFixed(2)}$` : '')
        + ` · train ${(r.trainNet ?? 0) >= 0 ? '+' : ''}${(r.trainNet ?? 0).toFixed(2)}$`,
      );
    }

    mkdirSync(path.join(process.cwd(), 'data'), { recursive: true });
    const file = path.join(process.cwd(), 'data', 'sweep-report.json');
    writeFileSync(file, JSON.stringify({ from, to, rows }, null, 2));
    console.log(`\nОтчёт: ${file}`);
  })().catch(e => {
    console.error(e);
    process.exit(1);
  });
}
