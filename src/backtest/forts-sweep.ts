// FORTS-разведка (22.09.2026): наши семейства (meanrev / impulse / matrend) на фьючерсах
// Мосбиржи — та же механика и сетка, что у moex-sweep (акции), но издержки срочного рынка.
// Мотив — живые кейсы (docs/STOP-ETH-2026-09-22.md §4): верифицированные победители РФ
// сидят на FORTS, а наши минутные края на акциях умирали от 0.1 % комиссии и спреда 2-3 бп.
// Спред = 1 тик (ликвидные ближние контракты). Две модели комиссии за круг:
//   A — Т-Инвестиции «Трейдер», допущение 0.04 %/сторона → 0.08 % (проверить по тарифу);
//   B — брокер с поконтрактной комиссией (Финам/БКС ~1 ₽/контракт) → 0.01 %.
// Вердикт ячейки: net > 0 на train (70 % сделок) И test (30 %) по модели A; B — справочно.
//
// CLI: npx tsx src/backtest/forts-sweep.ts [--from 2026-01-01] [--to 2026-09-21] [--roots Si,BR]

import { pathToFileURL } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PIP } from '../broker/types';
import { AgentParams, DEFAULT_PARAMS } from '../agent/params';
import { buildStrategy } from '../agent/strategy';
import { FORTS_ROOTS, FortsCandle, loadFortsM1 } from './forts-data';

const FEE_A = 0.0008, FEE_B = 0.0001;
const UNITS = 1000;

interface Cell {
  root: string; strategy: string; entryMode: 'market' | 'limit'; params: string; trades: number;
  netTrainA: number; netTestA: number; netTrainB: number; netTestB: number; gross: number; wr: number;
  pctPerTradeA: number; // net A на сделку в % нотионала
  passA: boolean; passB: boolean;
}

function medianHourlyMovePips(candles: FortsCandle[], scale: number): number {
  const byHour = new Map<number, { hi: number; lo: number }>();
  for (const c of candles) {
    const k = Math.floor(c.t / 3600_000);
    const cur = byHour.get(k);
    if (!cur) byHour.set(k, { hi: c.h, lo: c.l }); else { cur.hi = Math.max(cur.hi, c.h); cur.lo = Math.min(cur.lo, c.l); }
  }
  const moves = [...byHour.values()].map(x => (x.hi - x.lo) / scale / PIP).filter(x => x > 0).sort((a, b) => a - b);
  return moves.length ? moves[Math.floor(moves.length / 2)] : NaN;
}

function runCell(candles: FortsCandle[], scale: number, params: AgentParams, spreadFrac: number): Array<{ gross: number; notional: number }> {
  const strategy = buildStrategy(params);
  const pnls: Array<{ gross: number; notional: number }> = [];
  let pending: { side: 'BUY' | 'SELL'; price: number; tp: number; sl: number; placedAt: number } | null = null;
  let open: { side: 'BUY' | 'SELL'; entry: number; tp: number; sl: number } | null = null;
  let cooldownUntil = 0, prevT = 0;
  const close = (exit: number): void => {
    if (!open) return;
    pnls.push({ gross: (open.side === 'BUY' ? exit - open.entry : open.entry - exit) * UNITS, notional: open.entry * UNITS });
    open = null;
  };
  for (const c of candles) {
    const mid = c.c / scale, half = (mid * spreadFrac) / 2, hi = c.h / scale, lo = c.l / scale;
    if (prevT && c.t - prevT > 30 * 60_000) { if (open) close(open.side === 'BUY' ? mid - half : mid + half); pending = null; }
    prevT = c.t;
    if (pending) {
      if (c.t - pending.placedAt > params.entryTtlSec * 1000) pending = null;
      else { const touch = pending.side === 'BUY' ? lo - half <= pending.price : hi + half >= pending.price; if (touch) { open = { side: pending.side, entry: pending.price, tp: pending.tp, sl: pending.sl }; pending = null; } }
    }
    if (open) {
      if (open.side === 'BUY') { if (lo - half <= open.sl) close(open.sl); else if (hi - half >= open.tp) close(open.tp); }
      else { if (hi + half >= open.sl) close(open.sl); else if (lo + half <= open.tp) close(open.tp); }
    }
    const sig = strategy.onQuote({ symbol: 'FORTS', bid: mid - half, ask: mid + half, time: new Date(c.t) });
    if (!sig || sig.both || open || pending || c.t < cooldownUntil) continue;
    cooldownUntil = c.t + params.cooldownSec * 1000;
    if (params.entryMode === 'market') {
      const entry = sig.side === 'BUY' ? mid + half : mid - half;
      open = { side: sig.side, entry, tp: sig.side === 'BUY' ? entry + sig.tpPips * PIP : entry - sig.tpPips * PIP, sl: sig.side === 'BUY' ? entry - sig.slPips * PIP : entry + sig.slPips * PIP };
    } else {
      const price = sig.side === 'BUY' ? mid - half : mid + half;
      pending = { side: sig.side, price, tp: sig.side === 'BUY' ? price + sig.tpPips * PIP : price - sig.tpPips * PIP, sl: sig.side === 'BUY' ? price - sig.slPips * PIP : price + sig.slPips * PIP, placedAt: c.t };
    }
  }
  return pnls;
}

function parseArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  (async () => {
    const from = new Date(parseArg('from') ?? '2026-01-01');
    const to = new Date(parseArg('to') ?? '2026-09-21');
    const roots = (parseArg('roots') ?? FORTS_ROOTS.map(r => r.root).join(',')).split(',').map(s => s.trim()).filter(Boolean);
    const cells: Cell[] = [];
    for (const root of roots) {
      const spec = FORTS_ROOTS.find(r => r.root === root);
      if (!spec) { console.log(`${root}: неизвестная серия — пропуск`); continue; }
      const { candles, rolls } = await loadFortsM1(spec, from, to);
      if (candles.length < 50_000) { console.log(`===== ${root}: мало данных (${candles.length}) — пропуск`); continue; }
      const p0 = candles[0].c;
      const scale = Math.pow(10, Math.ceil(Math.log10(p0)));
      const movePips = medianHourlyMovePips(candles, scale);
      const mult = Math.max(1, Math.round(movePips / 3.7));
      const spreadFrac = spec.tick / p0;
      const spreadPips = (p0 / scale) * spreadFrac / PIP;
      console.log(`===== ${root}: ${candles.length} минуток, стыков ${rolls.length} · цена ${p0} · scale ${scale} · ход ${movePips.toFixed(1)}п/ч · mult ${mult} · спред ${spreadPips.toFixed(2)}п (${(spreadFrac * 1e4).toFixed(2)}бп) · комиссия A ${(FEE_A * (p0 / scale) / PIP).toFixed(1)}п / B ${(FEE_B * (p0 / scale) / PIP).toFixed(1)}п за круг =====`);
      const strategies: Array<{ type: AgentParams['strategyType']; grid: Array<Partial<AgentParams>> }> = [
        { type: 'meanrev', grid: [1800, 3600].flatMap(w => [8, 16].map(thr => ({ windowSec: w, thresholdPips: thr * mult }))) },
        { type: 'impulse', grid: [1800, 3600].flatMap(w => [2, 6].map(thr => ({ windowSec: w, thresholdPips: thr * mult }))) },
        { type: 'matrend', grid: [7200, 14400].flatMap(w => [8, 12].map(thr => ({ windowSec: w, thresholdPips: thr * mult }))) },
      ];
      for (const st of strategies) for (const g of st.grid) for (const [tp, sl] of [[10, 20], [20, 40]] as const) for (const entryMode of ['market', 'limit'] as const) {
        const params: AgentParams = { ...DEFAULT_PARAMS, ...g, strategyType: st.type, entryMode, tpPips: tp * mult, slPips: sl * mult, cooldownSec: 900, entryTtlSec: 180 };
        const pnls = runCell(candles, scale, params, spreadFrac);
        if (pnls.length < 30) continue;
        const cut = Math.floor(pnls.length * 0.7);
        const net = (xs: typeof pnls, fee: number) => xs.reduce((s, x) => s + x.gross - fee * x.notional, 0);
        const tr = pnls.slice(0, cut), te = pnls.slice(cut);
        const notional = pnls.reduce((s, x) => s + x.notional, 0);
        const cell: Cell = {
          root, strategy: st.type, entryMode, params: `w${params.windowSec} thr${params.thresholdPips} tp${params.tpPips} sl${params.slPips}`, trades: pnls.length,
          netTrainA: +net(tr, FEE_A).toFixed(1), netTestA: +net(te, FEE_A).toFixed(1), netTrainB: +net(tr, FEE_B).toFixed(1), netTestB: +net(te, FEE_B).toFixed(1),
          gross: +pnls.reduce((s, x) => s + x.gross, 0).toFixed(1), wr: +(pnls.filter(x => x.gross > 0).length / pnls.length * 100).toFixed(1),
          pctPerTradeA: +(100 * net(pnls, FEE_A) / notional).toFixed(4),
          passA: net(tr, FEE_A) > 0 && net(te, FEE_A) > 0, passB: net(tr, FEE_B) > 0 && net(te, FEE_B) > 0,
        };
        cells.push(cell);
      }
      const mine = cells.filter(c => c.root === root);
      const pa = mine.filter(c => c.passA), pb = mine.filter(c => c.passB);
      console.log(`  ячеек ${mine.length}, прошло A: ${pa.length}, B: ${pb.length}`);
      for (const p of pa.slice().sort((a, b) => b.netTestA - a.netTestA).slice(0, 5)) console.log(`  ✅A ${p.strategy}/${p.entryMode} ${p.params}: train ${p.netTrainA} · test ${p.netTestA} (${p.trades} сд, wr ${p.wr}%, ${p.pctPerTradeA}%/сд)`);
      for (const p of pb.filter(c => !c.passA).slice().sort((a, b) => b.netTestB - a.netTestB).slice(0, 3)) console.log(`  ✅B(только) ${p.strategy}/${p.entryMode} ${p.params}: train ${p.netTrainB} · test ${p.netTestB} (${p.trades} сд, wr ${p.wr}%)`);
      const best = mine.slice().sort((a, b) => b.netTestA - a.netTestA)[0];
      if (!pa.length && best) console.log(`  лучшее по A (не прошло): ${best.strategy}/${best.entryMode} ${best.params}: train ${best.netTrainA} · test ${best.netTestA} · gross ${best.gross}`);
    }
    console.log(`\nИТОГ: ячеек ${cells.length}, прошло по A: ${cells.filter(c => c.passA).length}, по B: ${cells.filter(c => c.passB).length}`);
    const outPath = path.join(process.cwd(), 'data', 'forts-report.json');
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify({ from, to, feeA: FEE_A, feeB: FEE_B, cells }, null, 1));
    console.log(`JSON: ${outPath}\nDONE`);
  })().catch(e => { console.error(e); process.exit(1); });
}
