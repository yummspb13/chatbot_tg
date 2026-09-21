// Стоп SIBN — второй движок: механика moex-sweep (та, которой ячейки лицензировались):
// без трейла, касание по h/l свечи, SL приоритетнее TP внутри свечи, форс-выход на разрыве
// >30 мин по mid±half, комиссия 0.1%/круг, TTL лимитки 180с, cooldown 900с. Те же варианты
// SL ∈ {1×,1.5×,2×}TP, окно март→21.09, календарный сплит train до 01.07 / test с 01.07.
(async () => {
const { loadMoexM1 } = await import('../../backtest/moex-data');
const { buildStrategy } = await import('../../agent/strategy');
const { MOEX_LEGS } = await import('../../agent/moexleg');
const { PIP } = await import('../../broker/types');
const FROM = new Date('2026-03-01T00:00:00Z'), TO = new Date('2026-09-21T00:00:00Z'), SPLIT = new Date('2026-07-01T00:00:00Z').getTime();
const FEE = 0.001, UNITS = 1000;
const SPREADS: Record<string, number> = { SIBN: 0.00032, AFKS: 0.00021 };
const CASES = [{ ticker: 'SIBN', cells: ['sibn-meanrev2', 'sibn-meanrev'] }, { ticker: 'AFKS', cells: ['afks-meanrev2'] }];
function runCell(candles: any[], scale: number, params: any, sf: number) {
  const strategy = buildStrategy(params); const trades: Array<{ t: number; pnl: number; reason: string }> = [];
  let pending: any = null, open: any = null, cooldownUntil = 0, prevT = 0;
  const close = (exit: number, t: number, reason: string) => { if (!open) return; const g = (open.side === 'BUY' ? exit - open.entry : open.entry - exit) * UNITS; trades.push({ t: open.t, pnl: g - FEE * open.entry * UNITS, reason }); open = null; };
  for (const c of candles) {
    const mid = c.c / scale, half = (mid * sf) / 2, hi = c.h / scale, lo = c.l / scale;
    if (prevT && c.t - prevT > 30 * 60_000) { if (open) close(open.side === 'BUY' ? mid - half : mid + half, c.t, 'GAP'); pending = null; }
    prevT = c.t;
    if (pending) { if (c.t - pending.placedAt > params.entryTtlSec * 1000) pending = null; else { const touch = pending.side === 'BUY' ? lo - half <= pending.price : hi + half >= pending.price; if (touch) { open = { side: pending.side, entry: pending.price, tp: pending.tp, sl: pending.sl, t: c.t }; pending = null; } } }
    if (open) { if (open.side === 'BUY') { if (lo - half <= open.sl) close(open.sl, c.t, 'SL'); else if (hi - half >= open.tp) close(open.tp, c.t, 'TP'); } else { if (hi + half >= open.sl) close(open.sl, c.t, 'SL'); else if (lo + half <= open.tp) close(open.tp, c.t, 'TP'); } }
    const sig = strategy.onQuote({ symbol: 'X', bid: mid - half, ask: mid + half, time: new Date(c.t) });
    if (!sig || sig.both || open || pending || c.t < cooldownUntil) continue;
    cooldownUntil = c.t + params.cooldownSec * 1000;
    if (params.entryMode === 'market') { const e = sig.side === 'BUY' ? mid + half : mid - half; open = { side: sig.side, entry: e, tp: sig.side === 'BUY' ? e + sig.tpPips * PIP : e - sig.tpPips * PIP, sl: sig.side === 'BUY' ? e - sig.slPips * PIP : e + sig.slPips * PIP, t: c.t }; }
    else { const pr = sig.side === 'BUY' ? mid - half : mid + half; pending = { side: sig.side, price: pr, tp: sig.side === 'BUY' ? pr + sig.tpPips * PIP : pr - sig.tpPips * PIP, sl: sig.side === 'BUY' ? pr - sig.slPips * PIP : pr + sig.slPips * PIP, placedAt: c.t }; }
  }
  return trades;
}
const stat = (ts: any[]) => { const net = ts.reduce((s, t) => s + t.pnl, 0); const reasons: Record<string, number> = {}; for (const t of ts) reasons[t.reason] = (reasons[t.reason] ?? 0) + 1; return { n: ts.length, net: +net.toFixed(1), wr: ts.length ? +(ts.filter(t => t.pnl > 0).length / ts.length).toFixed(2) : null, exp: ts.length ? +(net / ts.length).toFixed(2) : null, reasons }; };
const fmt = (s: any) => `${s.n} сд net ${s.net >= 0 ? '+' : ''}${s.net}$ wr ${s.wr} exp ${s.exp} [${Object.entries(s.reasons).map(([k, v]) => `${k} ${v}`).join(' ')}]`;
for (const cs of CASES) {
  const spec = MOEX_LEGS.find((s: any) => s.ticker === cs.ticker)!; const scale = spec.priceScale;
  const candles = (await loadMoexM1(cs.ticker, FROM, TO)).filter((c: any) => c.t >= FROM.getTime() && c.t < TO.getTime());
  for (const key of cs.cells) {
    const base = spec.roster.find((m: any) => m.key === key)!.params;
    const res = [1, 1.5, 2].map(k => { const p = { ...base, slPips: Math.round(base.tpPips * k), trailAfterTpFrac: 0 }; const ts = runCell(candles, scale, p, SPREADS[cs.ticker]); return { k, sl: p.slPips, train: stat(ts.filter(t => t.t < SPLIT)), test: stat(ts.filter(t => t.t >= SPLIT)) }; });
    const b = res[2];
    console.log(`\n=== [свип-механика, без трейла] ${cs.ticker} ${key}: tp ${base.tpPips} ===`);
    for (const r of res) { const ok = r.k !== 2 && r.train.net > b.train.net && r.test.net > b.test.net && r.test.net > 0; console.log(`  SL=${r.sl} (${r.k}×TP)${r.k === 2 ? ' БАЗА' : ''}: train ${fmt(r.train)} | test ${fmt(r.test)}${r.k === 2 ? '' : ok ? '  ✅' : '  —'}`); }
  }
}
console.log('\nDONE'); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
