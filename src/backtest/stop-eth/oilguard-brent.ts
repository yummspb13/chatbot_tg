// oilguard с Brent (план владельца). Правило ДО прогона: тот же гейт, что в проде у -og
// (блок ВСЕХ входов, пока активен шок: часовой |лог-ход| нефти > 2σ, память 60 мин), источник
// шока ∈ {WTI, Brent}, σ ∈ {fixed по train-окну источника, roll20 — скользящее std за 20 дней};
// ячейки sibn-meanrev2 (SL 60, трейл 0.2) и sibn-meanrev; EnsembleLeg (GAP исправлен), окно
// март→21.09, train до 01.07 / test с 01.07. Контроль — без гейта. Вердикт: net > контроля на
// train И test. Нет свежей нефтяной свечи (>15 мин) → fail-open, как в проде.
(async () => {
const { EnsembleLeg } = await import('../../agent/ensemble');
const { loadMoexM1 } = await import('../../backtest/moex-data');
const { loadM1 } = await import('../../backtest/data');
const { MOEX_LEGS } = await import('../../agent/moexleg');
const fs = await import('node:fs');
const FROM = new Date('2026-03-01T00:00:00Z'), TO = new Date('2026-09-21T00:00:00Z'), SPLIT = new Date('2026-07-01T00:00:00Z');
const K = 2, MEMORY_MS = 60 * 60_000, LOOK_MS = 60 * 60_000, TOL_MS = 5 * 60_000, STALE_MS = 15 * 60_000;
const SPREAD_SIBN = 0.00032;
type Sign = { t: number; sign: number };
function shockSeries(candles: any[], mode: 'fixed' | 'roll20'): { series: Sign[]; sigmaFixed: number } {
  const ts = candles.map(c => c.t), px = candles.map(c => c.c);
  // часовые лог-ходы
  const r: Array<number | null> = new Array(candles.length).fill(null);
  let j = 0;
  for (let i = 0; i < candles.length; i++) {
    const target = ts[i] - LOOK_MS;
    while (j + 1 < candles.length && ts[j + 1] <= target) j++;
    if (ts[j] <= target && target - ts[j] <= TOL_MS) r[i] = Math.log(px[i] / px[j]);
  }
  const trainR = r.filter((x, i): x is number => x !== null && ts[i] < SPLIT.getTime());
  const std = (xs: number[]) => { const m = xs.reduce((a, b) => a + b, 0) / xs.length; return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, xs.length - 1)); };
  const sigmaFixed = std(trainR);
  // roll20: σ по предыдущим 20 дням (по индексам, пересчёт раз в день)
  const series: Sign[] = [];
  let lastShock: { t: number; sign: number } | null = null;
  let sigma = sigmaFixed, dayKey = '', lo = 0;
  for (let i = 0; i < candles.length; i++) {
    if (mode === 'roll20') {
      const dk = new Date(ts[i]).toISOString().slice(0, 10);
      if (dk !== dayKey) {
        dayKey = dk;
        while (lo < i && ts[lo] < ts[i] - 20 * 86400_000) lo++;
        const win: number[] = []; for (let k = lo; k < i; k++) if (r[k] !== null) win.push(r[k] as number);
        if (win.length >= 2000) sigma = std(win); // иначе — остаётся прошлое значение (или fixed на старте)
      }
    }
    const ri = r[i];
    if (ri !== null && Math.abs(ri) > K * sigma) lastShock = { t: ts[i], sign: Math.sign(ri) };
    series.push({ t: ts[i], sign: lastShock && ts[i] - lastShock.t <= MEMORY_MS ? lastShock.sign : 0 });
  }
  return { series, sigmaFixed };
}
function lookup(series: Sign[]) {
  const ts = series.map(s => s.t);
  return (t: number): number => {
    let lo = 0, hi = ts.length - 1, idx = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (ts[m] <= t) { idx = m; lo = m + 1; } else hi = m - 1; }
    if (idx < 0 || t - ts[idx] > STALE_MS) return 0; // нет свежей нефти → fail-open
    const s = series[idx];
    return s.sign !== 0 && t - (s.t) <= MEMORY_MS ? s.sign : (s.sign !== 0 ? s.sign : 0);
  };
}
function memStore() { const rows: any[] = []; let id = 1; return { rows, persistent: false,
  openTrade: async (t: any) => { const r = { id: id++, ...t, exitPrice: null, closedAt: null, pnl: null, closeReason: null }; rows.push(r); return r; },
  closeTradeById: async (rid: number, c: any) => { const r = rows.find(x => x.id === rid); if (r) Object.assign(r, c); },
  closedTradesSince: async (_m: string, s: Date) => rows.filter(r => r.closedAt && r.closedAt >= s),
  countTradesToday: async () => 0, realizedPnlToday: async () => 0, listOpenTrades: async () => [] } as any; }
const stat = (rs: any[]) => { const net = rs.reduce((s, r) => s + (r.pnl ?? 0), 0); return { n: rs.length, net: +net.toFixed(1), wr: rs.length ? +(rs.filter(r => r.pnl > 0).length / rs.length).toFixed(2) : null }; };
const fmt = (s: any) => `${s.n} сд net ${s.net >= 0 ? '+' : ''}${s.net}$ wr ${s.wr}`;

const oil: Record<string, any[]> = {};
for (const [name, inst] of [['WTI', 'lightcmdusd'], ['Brent', 'brentcmdusd']] as const) {
  oil[name] = (await loadM1(inst, new Date('2026-02-01T00:00:00Z'), TO)).filter((c: any) => c.t < TO.getTime());
}
const gates: Record<string, (t: number) => number> = {};
const sigmas: string[] = [];
let shockShare: string[] = [];
for (const src of ['WTI', 'Brent']) for (const mode of ['fixed', 'roll20'] as const) {
  const { series, sigmaFixed } = shockSeries(oil[src], mode);
  gates[`${src}-${mode}`] = lookup(series);
  if (mode === 'fixed') sigmas.push(`${src} σ60(train)=${sigmaFixed.toFixed(5)}`);
  const inWin = series.filter(s => s.t >= FROM.getTime());
  shockShare.push(`${src}-${mode}: доля минут под шоком ${(100 * inWin.filter(s => s.sign !== 0).length / inWin.length).toFixed(1)}%`);
}
console.log(sigmas.join(' | ') + ' (в проде WTI 0.00568)');
console.log(shockShare.join(' | '));
const spec = MOEX_LEGS.find((s: any) => s.ticker === 'SIBN')!;
const candles = (await loadMoexM1('SIBN', FROM, TO)).filter((c: any) => c.t >= FROM.getTime() && c.t < TO.getTime()).map((c: any) => ({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, sp: c.c * SPREAD_SIBN }));
const out: any[] = [];
for (const key of ['sibn-meanrev2', 'sibn-meanrev']) {
  const base = spec.roster.find((m: any) => m.key === key)!.params;
  const variants = ['control', ...Object.keys(gates)];
  const roster = variants.map(v => ({ key: `${key}~${v}`, params: { ...base } }));
  const store = memStore();
  const leg: any = new EnsembleLeg({ store, isNewsBlackout: () => false }, {
    baseSymbol: 'SIBN', crypto: false, warmup: null, commissionFrac: 0.001, gapCloseMin: 30, fillMode: 'touch',
    entryGuard: (memberKey: string, _side: string, time: Date) => { const v = memberKey.split('~')[1]; return v === 'control' || gates[v](time.getTime()) === 0; },
  }, roster as any);
  await leg.replayCandles(candles, spec.priceScale, FROM);
  const rows: Record<string, any> = {};
  for (const v of variants) {
    const rs = store.rows.filter((r: any) => r.symbol === `SIBN~${key}~${v}` && r.closedAt);
    rows[v] = { train: stat(rs.filter((r: any) => r.openedAt < SPLIT)), test: stat(rs.filter((r: any) => r.openedAt >= SPLIT)) };
  }
  const c = rows.control;
  console.log(`\n=== SIBN ${key} (tp ${base.tpPips} sl ${base.slPips}, трейл ${base.trailAfterTpFrac}) ===`);
  for (const v of variants) {
    const r = rows[v]; const ok = v !== 'control' && r.train.net > c.train.net && r.test.net > c.test.net;
    console.log(`  ${v.padEnd(12)} train ${fmt(r.train)} | test ${fmt(r.test)}${v === 'control' ? '  (контроль)' : ok ? '  ✅ лучше контроля на train И test' : '  —'}`);
    out.push({ cell: key, variant: v, ...r, pass: ok });
  }
}
fs.writeFileSync('data/stop-eth-2026-09-22/oilguard-brent-result.json', JSON.stringify(out, null, 1));
console.log('\nDONE'); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
