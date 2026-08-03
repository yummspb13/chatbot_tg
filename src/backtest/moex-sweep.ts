// MOEX-разведка: наши продовые стратегии на российских голубых фишках —
// офлайн, с честной моделью издержек РФ-брокера. Ни счёта, ни рубля риска.
//
// Тезис владельца: изолированный рынок (~80% оборота — физики, иностранных
// арбитражёров нет) должен быть паттернистее. Антитезис: процентные комиссии
// РФ-брокеров — та же арифметика, что похоронила мемкоины. Меряем.
//
// Механика: минутки ISS → синтетические котировки (mid ± половина модельного
// спреда 0.02%) → НАСТОЯЩИЕ стратегии из strategy.ts (meanrev / impulse /
// matrend — три семейства, побеждавшие на других рынках) → лимитные/рыночные
// входы, TP/SL по тикам, форс-выход на сессионных разрывах (>30 мин) —
// овернайт-гэпы через стопы не прыгают. Комиссия 0.1% нотионала за круг
// (уровень розничных тарифов Т-Инвест/ВТБ) вычитается при закрытии.
// Вердикт ячейки: плюс на train (70%) И test (30%) ПОСЛЕ комиссий.
//
// CLI: npx tsx src/backtest/moex-sweep.ts [--from 2024-01-01] [--to 2026-07-30]

import { pathToFileURL } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PIP } from '../broker/types';
import { AgentParams, DEFAULT_PARAMS } from '../agent/params';
import { buildStrategy } from '../agent/strategy';
import { loadMoexM1, MoexCandle } from './moex-data';

const TICKERS = ['SBER', 'GAZP', 'LKOH', 'ROSN', 'TATN', 'MGNT'];
const SPREAD_FRAC = 0.0002; // 0.02% — консервативно для голубых фишек TQBR
const FEE_ROUND_FRAC = 0.001; // 0.1% нотионала за круг (две стороны по 0.05%)
const UNITS = 1000;

interface Cell {
  ticker: string;
  strategy: string;
  entryMode: 'market' | 'limit';
  params: string;
  trades: number;
  grossTrain: number;
  netTrain: number;
  grossTest: number;
  netTest: number;
  feeTotal: number;
  wr: number;
  pass: boolean;
}

function medianHourlyMovePips(candles: MoexCandle[], scale: number): number {
  const byHour = new Map<number, { hi: number; lo: number }>();
  for (const c of candles) {
    const k = Math.floor(c.t / 3600_000);
    const cur = byHour.get(k);
    if (!cur) byHour.set(k, { hi: c.h, lo: c.l });
    else {
      cur.hi = Math.max(cur.hi, c.h);
      cur.lo = Math.min(cur.lo, c.l);
    }
  }
  const moves = [...byHour.values()].map(x => (x.hi - x.lo) / scale / PIP).filter(x => x > 0).sort((a, b) => a - b);
  return moves.length ? moves[Math.floor(moves.length / 2)] : NaN;
}

function runCell(
  candles: MoexCandle[], scale: number, params: AgentParams,
): { pnls: Array<{ gross: number; fee: number }>; } {
  const strategy = buildStrategy(params);
  const pnls: Array<{ gross: number; fee: number }> = [];
  let pending: { side: 'BUY' | 'SELL'; price: number; tp: number; sl: number; placedAt: number } | null = null;
  let open: { side: 'BUY' | 'SELL'; entry: number; tp: number; sl: number } | null = null;
  let cooldownUntil = 0;
  let prevT = 0;

  const close = (exit: number): void => {
    if (!open) return;
    const gross = (open.side === 'BUY' ? exit - open.entry : open.entry - exit) * UNITS;
    const fee = FEE_ROUND_FRAC * open.entry * UNITS;
    pnls.push({ gross, fee });
    open = null;
  };

  for (const c of candles) {
    const mid = c.c / scale;
    const half = (mid * SPREAD_FRAC * scale) / scale / 2; // половина спреда 0.02%
    const hi = c.h / scale;
    const lo = c.l / scale;

    // сессионный разрыв: форс-выход по последней цене, заявки снимаются
    if (prevT && c.t - prevT > 30 * 60_000) {
      if (open) close(open.side === 'BUY' ? mid - half : mid + half);
      pending = null;
    }
    prevT = c.t;

    // исполнение лимитки
    if (pending) {
      if (c.t - pending.placedAt > params.entryTtlSec * 1000) pending = null;
      else {
        const touch = pending.side === 'BUY' ? lo - half <= pending.price : hi + half >= pending.price;
        if (touch) {
          open = { side: pending.side, entry: pending.price, tp: pending.tp, sl: pending.sl };
          pending = null;
        }
      }
    }

    // TP/SL (SL первым — пессимизм)
    if (open) {
      if (open.side === 'BUY') {
        if (lo - half <= open.sl) close(open.sl);
        else if (hi - half >= open.tp) close(open.tp);
      } else {
        if (hi + half >= open.sl) close(open.sl);
        else if (lo + half <= open.tp) close(open.tp);
      }
    }

    // сигнал
    const sig = strategy.onQuote({ symbol: 'MOEX', bid: mid - half, ask: mid + half, time: new Date(c.t) });
    if (!sig || sig.both || open || pending || c.t < cooldownUntil) continue;
    cooldownUntil = c.t + params.cooldownSec * 1000;
    if (params.entryMode === 'market') {
      const entry = sig.side === 'BUY' ? mid + half : mid - half;
      open = {
        side: sig.side, entry,
        tp: sig.side === 'BUY' ? entry + sig.tpPips * PIP : entry - sig.tpPips * PIP,
        sl: sig.side === 'BUY' ? entry - sig.slPips * PIP : entry + sig.slPips * PIP,
      };
    } else {
      const price = sig.side === 'BUY' ? mid - half : mid + half;
      pending = {
        side: sig.side, price,
        tp: sig.side === 'BUY' ? price + sig.tpPips * PIP : price - sig.tpPips * PIP,
        sl: sig.side === 'BUY' ? price - sig.slPips * PIP : price + sig.slPips * PIP,
        placedAt: c.t,
      };
    }
  }
  return { pnls };
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
    const cells: Cell[] = [];

    for (const ticker of TICKERS) {
      const candles = await loadMoexM1(ticker, from, to);
      if (candles.length < 50_000) {
        console.log(`===== ${ticker}: мало данных (${candles.length}) — пропуск`);
        continue;
      }
      const p0 = candles[0].c;
      const scale = Math.pow(10, Math.ceil(Math.log10(p0)));
      const movePips = medianHourlyMovePips(candles, scale);
      const mult = Math.max(1, Math.round(movePips / 3.7));
      const spreadPips = (p0 / scale) * SPREAD_FRAC / PIP;
      const feePips = FEE_ROUND_FRAC * (p0 / scale) / PIP;
      console.log(`===== ${ticker}: ${candles.length} минуток · цена ${p0}₽ · scale ${scale} · ход ${movePips.toFixed(1)}п/ч · mult ${mult} · спред ${spreadPips.toFixed(1)}п · комиссия/круг ~${feePips.toFixed(1)}п =====`);

      const strategies: Array<{ type: AgentParams['strategyType']; grid: Array<Partial<AgentParams>> }> = [
        {
          type: 'meanrev',
          grid: [1800, 3600].flatMap(w => [8, 16].map(thr => ({ windowSec: w, thresholdPips: thr * mult }))),
        },
        {
          type: 'impulse',
          grid: [1800, 3600].flatMap(w => [2, 6].map(thr => ({ windowSec: w, thresholdPips: thr * mult }))),
        },
        {
          type: 'matrend',
          grid: [7200, 14400].flatMap(w => [8, 12].map(thr => ({ windowSec: w, thresholdPips: thr * mult }))),
        },
      ];
      for (const st of strategies) {
        for (const g of st.grid) {
          for (const [tp, sl] of [[10, 20], [20, 40]] as const) {
            for (const entryMode of ['market', 'limit'] as const) {
              const params: AgentParams = {
                ...DEFAULT_PARAMS, ...g,
                strategyType: st.type, entryMode,
                tpPips: tp * mult, slPips: sl * mult,
                cooldownSec: 900, entryTtlSec: 180,
              };
              const { pnls } = runCell(candles, scale, params);
              if (pnls.length < 30) continue;
              const cut = Math.floor(pnls.length * 0.7);
              const sum = (xs: typeof pnls, f: (x: typeof pnls[0]) => number) => xs.reduce((s, x) => s + f(x), 0);
              const train = pnls.slice(0, cut);
              const test = pnls.slice(cut);
              const cell: Cell = {
                ticker, strategy: st.type, entryMode,
                params: `w${params.windowSec} thr${params.thresholdPips} tp${params.tpPips} sl${params.slPips}`,
                trades: pnls.length,
                grossTrain: +sum(train, x => x.gross).toFixed(1),
                netTrain: +sum(train, x => x.gross - x.fee).toFixed(1),
                grossTest: +sum(test, x => x.gross).toFixed(1),
                netTest: +sum(test, x => x.gross - x.fee).toFixed(1),
                feeTotal: +sum(pnls, x => x.fee).toFixed(1),
                wr: +(pnls.filter(x => x.gross > 0).length / pnls.length * 100).toFixed(1),
                pass: sum(train, x => x.gross - x.fee) > 0 && sum(test, x => x.gross - x.fee) > 0,
              };
              cells.push(cell);
            }
          }
        }
      }
      const mine = cells.filter(c => c.ticker === ticker);
      const passed = mine.filter(c => c.pass);
      const best = mine.slice().sort((a, b) => b.netTest - a.netTest)[0];
      console.log(`  ячеек ${mine.length}, прошло после комиссий: ${passed.length}`);
      for (const p of passed.slice(0, 5)) {
        console.log(`  ✅ ${p.strategy}/${p.entryMode} ${p.params}: train ${p.grossTrain}→${p.netTrain} · test ${p.grossTest}→${p.netTest} (${p.trades} сд, wr ${p.wr}%)`);
      }
      if (!passed.length && best) {
        console.log(`  лучшее (не прошло): ${best.strategy}/${best.entryMode} ${best.params}: train net ${best.netTrain} · test net ${best.netTest} · комиссий ${best.feeTotal}`);
      }
    }

    const passed = cells.filter(c => c.pass);
    console.log(`\nИТОГ: ячеек ${cells.length}, прошло после RF-комиссий: ${passed.length}`);
    const outPath = path.join(process.cwd(), 'data', 'moex-report.json');
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify({ from, to, spreadFrac: SPREAD_FRAC, feeRoundFrac: FEE_ROUND_FRAC, cells }, null, 1));
    console.log(`JSON: ${outPath}\nDONE`);
  })().catch(e => {
    console.error(e);
    process.exit(1);
  });
}
