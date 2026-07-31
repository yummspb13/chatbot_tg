// Бэктест: ТОТ ЖЕ код стратегии и риск-модуля, что торгует вживую,
// прогоняется по M1-истории с моделью издержек (спред + расширение на ролловере).
// Оговорки: новостной фильтр в бэктесте не применяется (нет бесплатного
// исторического календаря); прошлое не гарантирует будущее.
//
// CLI:
//   npm run backtest -- --from 2024-01-01 --to 2026-07-01            # дефолтные параметры
//   npm run backtest -- --from 2024-01-01 --to 2026-07-01 --optimize # walk-forward подбор

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PIP } from '../broker/types';
import { AgentParams, clampParams, DEFAULT_PARAMS } from '../agent/params';
import { MomentumStrategy } from '../agent/strategy';
import { RiskManager } from '../agent/risk';
import { Candle, loadM1 } from './data';

export interface BtTrade {
  side: 'BUY' | 'SELL';
  entry: number;
  exit: number;
  pnl: number;
  spreadCost: number;
  openedAt: number;
  closedAt: number;
  reason: string;
  hourUtc: number;
}

export interface BtReport {
  from: string;
  to: string;
  params: AgentParams;
  candles: number;
  trades: number;
  wins: number;
  winRate: number;
  netUsd: number;
  spreadCostUsd: number;
  grossUsd: number;
  expectancyUsd: number;
  maxDrawdownUsd: number;
  profitFactor: number;
  tradesPerWeek: number;
  killDays: number;
  byHour: { hour: number; n: number; netUsd: number }[];
}

/** Модель спреда: ~1 pip обычно, шире на ролловере и открытии недели. */
function spreadPipsAt(t: Date): number {
  const h = t.getUTCHours();
  const day = t.getUTCDay();
  if (h === 21 || h === 22) return 2.5; // ролловер
  if (day === 0) return 2.0; // воскресное открытие
  return 1.0;
}

interface OpenPos {
  side: 'BUY' | 'SELL';
  entry: number;
  tp: number;
  sl: number;
  units: number;
  openedAt: number;
  spreadCost: number;
}

export function runBacktest(candles: Candle[], paramsIn: Partial<AgentParams>): BtReport {
  const params = clampParams({ ...DEFAULT_PARAMS, ...paramsIn });
  const strategy = new MomentumStrategy(params);
  const risk = new RiskManager(params);

  const trades: BtTrade[] = [];
  let open: OpenPos[] = [];
  let dayKey = '';
  let tradesToday = 0;
  let realizedToday = 0;
  let killedToday = false;
  let killDays = 0;

  const closePos = (p: OpenPos, exit: number, at: number, reason: string) => {
    const pnl = (p.side === 'BUY' ? exit - p.entry : p.entry - exit) * p.units;
    realizedToday += pnl;
    trades.push({
      side: p.side, entry: p.entry, exit, pnl, spreadCost: p.spreadCost,
      openedAt: p.openedAt, closedAt: at, reason, hourUtc: new Date(p.openedAt).getUTCHours(),
    });
  };

  for (const c of candles) {
    const time = new Date(c.t);
    const spreadPips = spreadPipsAt(time);
    const half = (spreadPips * PIP) / 2;

    // новый торговый день (UTC)
    const key = time.toISOString().slice(0, 10);
    if (key !== dayKey) {
      dayKey = key;
      tradesToday = 0;
      realizedToday = 0;
      killedToday = false;
    }

    // TP/SL внутри свечи; если задеты оба — пессимистично считаем SL
    const still: OpenPos[] = [];
    for (const p of open) {
      let exit: number | null = null;
      let reason = '';
      if (p.side === 'BUY') {
        const bidLow = c.l - half;
        const bidHigh = c.h - half;
        if (bidLow <= p.sl) { exit = p.sl; reason = 'SL'; }
        else if (bidHigh >= p.tp) { exit = p.tp; reason = 'TP'; }
      } else {
        const askHigh = c.h + half;
        const askLow = c.l + half;
        if (askHigh >= p.sl) { exit = p.sl; reason = 'SL'; }
        else if (askLow <= p.tp) { exit = p.tp; reason = 'TP'; }
      }
      if (exit !== null) closePos(p, exit, c.t, reason);
      else still.push(p);
    }
    open = still;

    // kill-switch по дневному убытку — закрыть всё и не торговать до конца дня
    if (!killedToday && realizedToday <= -params.maxDailyLossUsd) {
      for (const p of open) {
        const exit = p.side === 'BUY' ? c.c - half : c.c + half;
        closePos(p, exit, c.t, 'KILL');
      }
      open = [];
      killedToday = true;
      killDays += 1;
    }

    const bid = c.c - half;
    const ask = c.c + half;
    const sig = strategy.onQuote({ symbol: 'EUR_USD', bid, ask, time });
    if (!sig || killedToday) continue;

    const verdict = risk.check({
      now: time,
      openCount: open.length,
      tradesToday,
      plToday: realizedToday,
      spreadPips,
      newsBlackout: false,
    });
    if (!verdict.ok) continue;

    const entry = sig.side === 'BUY' ? ask : bid;
    open.push({
      side: sig.side,
      entry,
      tp: sig.side === 'BUY' ? entry + sig.tpPips * PIP : entry - sig.tpPips * PIP,
      sl: sig.side === 'BUY' ? entry - sig.slPips * PIP : entry + sig.slPips * PIP,
      units: params.units,
      openedAt: c.t,
      spreadCost: spreadPips * PIP * params.units,
    });
    tradesToday += 1;
  }

  // закрыть хвост по последней цене
  if (candles.length) {
    const last = candles[candles.length - 1];
    const half = (spreadPipsAt(new Date(last.t)) * PIP) / 2;
    for (const p of open) {
      closePos(p, p.side === 'BUY' ? last.c - half : last.c + half, last.t, 'EOD');
    }
    open = [];
  }

  const netUsd = trades.reduce((s, t) => s + t.pnl, 0);
  const spreadCostUsd = trades.reduce((s, t) => s + t.spreadCost, 0);
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl < 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));

  let peak = 0;
  let dd = 0;
  let cum = 0;
  for (const t of trades) {
    cum += t.pnl;
    if (cum > peak) peak = cum;
    if (peak - cum > dd) dd = peak - cum;
  }

  const byHourMap = new Map<number, { n: number; netUsd: number }>();
  for (const t of trades) {
    const b = byHourMap.get(t.hourUtc) ?? { n: 0, netUsd: 0 };
    b.n += 1;
    b.netUsd += t.pnl;
    byHourMap.set(t.hourUtc, b);
  }

  const weeks = candles.length ? (candles[candles.length - 1].t - candles[0].t) / (7 * 86400_000) : 1;

  return {
    from: candles.length ? new Date(candles[0].t).toISOString().slice(0, 10) : '',
    to: candles.length ? new Date(candles[candles.length - 1].t).toISOString().slice(0, 10) : '',
    params,
    candles: candles.length,
    trades: trades.length,
    wins: wins.length,
    winRate: trades.length ? wins.length / trades.length : 0,
    netUsd,
    spreadCostUsd,
    grossUsd: netUsd + spreadCostUsd,
    expectancyUsd: trades.length ? netUsd / trades.length : 0,
    maxDrawdownUsd: dd,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
    tradesPerWeek: trades.length / Math.max(weeks, 0.1),
    killDays,
    byHour: [...byHourMap.entries()].map(([hour, b]) => ({ hour, ...b })).sort((a, b) => a.hour - b.hour),
  };
}

export interface OptimizeResult {
  best: { params: Partial<AgentParams>; train: BtReport; test: BtReport } | null;
  table: { params: Partial<AgentParams>; trainNet: number; trainTrades: number; testNet?: number }[];
  split: number;
}

/** Walk-forward: подбор на train-периоде, честная проверка top-5 на test-периоде. */
export function optimize(candles: Candle[], split = 0.7, units = DEFAULT_PARAMS.units): OptimizeResult {
  const cut = Math.floor(candles.length * split);
  const train = candles.slice(0, cut);
  const test = candles.slice(cut);

  const grid: Partial<AgentParams>[] = [];
  for (const windowSec of [300, 900]) {
    for (const thresholdPips of [3, 5, 8]) {
      for (const tpPips of [10, 20]) {
        for (const slPips of [10, 20]) {
          grid.push({ windowSec, thresholdPips, tpPips, slPips, cooldownSec: windowSec, units });
        }
      }
    }
  }

  const table: OptimizeResult['table'] = [];
  const ranked: { params: Partial<AgentParams>; train: BtReport }[] = [];
  for (const g of grid) {
    const r = runBacktest(train, g);
    table.push({ params: g, trainNet: r.netUsd, trainTrades: r.trades });
    if (r.trades >= 50) ranked.push({ params: g, train: r });
  }
  ranked.sort((a, b) => b.train.netUsd - a.train.netUsd);

  let best: OptimizeResult['best'] = null;
  for (const cand of ranked.slice(0, 5)) {
    const t = runBacktest(test, cand.params);
    const row = table.find(x => x.params === cand.params);
    if (row) row.testNet = t.netUsd;
    if (!best || t.netUsd > best.test.netUsd) best = { params: cand.params, train: cand.train, test: t };
  }
  return { best, table, split };
}

export function formatReport(r: BtReport, title: string): string {
  const p = r.params;
  return [
    `— ${title} —`,
    `Период: ${r.from} → ${r.to} (${r.candles} минуток)`,
    `Параметры: window=${p.windowSec}s порог=${p.thresholdPips}p TP/SL=${p.tpPips}/${p.slPips}p units=${p.units}`,
    `Сделок: ${r.trades} (~${r.tradesPerWeek.toFixed(1)}/нед), win-rate ${(r.winRate * 100).toFixed(1)}%`,
    `Net: ${r.netUsd.toFixed(2)}$ · издержки спреда: ${r.spreadCostUsd.toFixed(2)}$ · gross: ${r.grossUsd.toFixed(2)}$`,
    `Ожидание: ${r.expectancyUsd >= 0 ? '+' : ''}${r.expectancyUsd.toFixed(3)}$/сделку · макс. просадка: ${r.maxDrawdownUsd.toFixed(2)}$ · PF: ${Number.isFinite(r.profitFactor) ? r.profitFactor.toFixed(2) : '∞'}`,
    `Дней с kill-switch: ${r.killDays}`,
  ].join('\n');
}

function parseArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  (async () => {
    const from = new Date(parseArg('from') ?? '2024-01-01');
    const to = new Date(parseArg('to') ?? new Date().toISOString().slice(0, 10));
    const doOptimize = process.argv.includes('--optimize');
    const candles = await loadM1(from, to);
    if (candles.length < 1000) {
      console.error('Слишком мало данных');
      process.exit(1);
    }

    const out: Record<string, unknown> = {};
    const base = runBacktest(candles, {});
    console.log(formatReport(base, 'Дефолтные параметры, весь период'));
    out.base = base;

    if (doOptimize) {
      console.log('\nWalk-forward подбор (train 70% / test 30%)…');
      const opt = optimize(candles, 0.7);
      out.optimize = opt;
      if (opt.best) {
        console.log(formatReport(opt.best.train, `Лучшие на train: ${JSON.stringify(opt.best.params)}`));
        console.log(formatReport(opt.best.test, 'Те же параметры на test (honest)'));
      } else {
        console.log('Ни одна комбинация не дала ≥50 сделок на train.');
      }
    }

    mkdirSync(path.join(process.cwd(), 'data'), { recursive: true });
    const file = path.join(process.cwd(), 'data', 'backtest-report.json');
    writeFileSync(file, JSON.stringify(out, null, 2));
    console.log(`\nОтчёт сохранён: ${file}`);
  })().catch(e => {
    console.error(e);
    process.exit(1);
  });
}
