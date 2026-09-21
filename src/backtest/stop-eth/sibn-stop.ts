// Стоп SIBN (план владельца): SL ∈ {1×, 1.5×, 2×(база)} TP для живых ячеек sibn-meanrev2
// (зеркалится счётом) и sibn-meanrev; вторично — afks-meanrev2 (второе зеркало).
// Правило ДО прогона: тот же EnsembleLeg, что торгует живьём (трейл 0.2, филлы touch,
// комиссия 0.1%/круг, GAP>30 мин, дневной лимит), спред = живой замер (доля цены),
// окно март→21.09, календарный сплит: train до 01.07, test с 01.07.
// Вердикт: вариант лучше базы (2×TP) по net на train И test строго, и test net > 0.
(async () => {
const { EnsembleLeg } = await import('../../agent/ensemble');
const { loadMoexM1 } = await import('../../backtest/moex-data');
const { MOEX_LEGS } = await import('../../agent/moexleg');
const fs = await import('node:fs');
const FROM = new Date('2026-03-01T00:00:00Z'), TO = new Date('2026-09-21T00:00:00Z'), SPLIT = new Date('2026-07-01T00:00:00Z');
const SPREAD: Record<string, number> = { SIBN: 0.00032, AFKS: 0.00021 };
const CASES = [
  { ticker: 'SIBN', cells: ['sibn-meanrev2', 'sibn-meanrev'] },
  { ticker: 'AFKS', cells: ['afks-meanrev2'] },
];
function memStore() { const rows: any[] = []; let id = 1; return { rows, persistent: false,
  openTrade: async (t: any) => { const r = { id: id++, ...t, exitPrice: null, closedAt: null, pnl: null, closeReason: null }; rows.push(r); return r; },
  closeTradeById: async (rid: number, c: any) => { const r = rows.find(x => x.id === rid); if (r) Object.assign(r, c); },
  closedTradesSince: async (_m: string, s: Date) => rows.filter(r => r.closedAt && r.closedAt >= s),
  countTradesToday: async () => 0, realizedPnlToday: async () => 0, listOpenTrades: async () => [] } as any; }
const stat = (rs: any[]) => {
  const net = rs.reduce((s, r) => s + (r.pnl ?? 0), 0), w = rs.filter(r => r.pnl > 0);
  const reasons: Record<string, number> = {}; for (const r of rs) reasons[r.closeReason ?? '?'] = (reasons[r.closeReason ?? '?'] ?? 0) + 1;
  return { n: rs.length, net: +net.toFixed(1), wr: rs.length ? +(w.length / rs.length).toFixed(2) : null, exp: rs.length ? +(net / rs.length).toFixed(2) : null, reasons };
};
const out: any[] = []; const lines: string[] = [];
for (const cs of CASES) {
  const spec = MOEX_LEGS.find((s: any) => s.ticker === cs.ticker)!;
  const scale = spec.priceScale;
  const raw = await loadMoexM1(cs.ticker, FROM, TO);
  const candles = raw.filter((c: any) => c.t >= FROM.getTime() && c.t < TO.getTime()).map((c: any) => ({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, sp: c.c * SPREAD[cs.ticker] }));
  for (const key of cs.cells) {
    const base = spec.roster.find((m: any) => m.key === key)!.params;
    // трейл 0.2 = как живьём; трейл 0 = сверка с механикой свипа (тот же движок, без трейла)
    const roster = [0.2, 0].flatMap(tr => [1, 1.5, 2].map(k => ({ key: `${key}~sl${k}${tr ? '' : '-notrail'}`, params: { ...base, slPips: Math.round(base.tpPips * k), trailAfterTpFrac: tr } })));
    const store = memStore();
    const leg: any = new EnsembleLeg({ store, isNewsBlackout: () => false }, { baseSymbol: cs.ticker, crypto: false, warmup: null, commissionFrac: 0.001, gapCloseMin: 30, fillMode: 'touch' }, roster as any);
    await leg.replayCandles(candles, scale, FROM);
    const rows: Record<string, any> = {};
    for (const m of roster) {
      const rs = store.rows.filter((r: any) => r.symbol === `${cs.ticker}~${m.key}` && r.closedAt);
      const tr = stat(rs.filter((r: any) => r.openedAt < SPLIT)), te = stat(rs.filter((r: any) => r.openedAt >= SPLIT));
      rows[m.key] = { sl: m.params.slPips, tp: m.params.tpPips, train: tr, test: te, all: stat(rs) };
    }
    lines.push(`\n=== ${cs.ticker} ${key}: tp ${base.tpPips}, ${candles.length} минуток, спред ${(SPREAD[cs.ticker] * 1e4).toFixed(1)}бп (EnsembleLeg, GAP исправлен) ===`);
    for (const m of roster) {
      const notrail = m.key.endsWith('-notrail'); const b = rows[`${key}~sl2${notrail ? '-notrail' : ''}`];
      const r = rows[m.key]; const isBase = m.key.endsWith('sl2') || m.key.endsWith('sl2-notrail');
      const ok = !isBase && r.train.net > b.train.net && r.test.net > b.test.net && r.test.net > 0;
      const fmt = (s: any) => `${s.n} сд net ${s.net >= 0 ? '+' : ''}${s.net}$ wr ${s.wr} exp ${s.exp} [${Object.entries(s.reasons).map(([k, v]) => `${k} ${v}`).join(' ')}]`;
      lines.push(`  ${notrail ? '[без трейла] ' : '[трейл 0.2] '}SL=${r.sl} (${(r.sl / r.tp).toFixed(1)}×TP)${isBase ? ' БАЗА' : ''}: train ${fmt(r.train)} | test ${fmt(r.test)}${isBase ? '' : ok ? '  ✅ лучше базы на train И test' : '  —'}`);
      out.push({ ticker: cs.ticker, cell: key, ...r, pass: ok });
    }
  }
}
console.log(lines.join('\n'));
fs.writeFileSync('data/stop-eth-2026-09-22/sibn-stop-result.json', JSON.stringify(out, null, 1));
console.log('\nDONE'); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
