// ETH-клон btc-matrend (план владельца). Правило ДО прогона: параметры = точная копия
// виртуала btc-matrend (matrend w7200 thr12 tp100 sl80 cd1800, лимитка, без трейла), тот же
// EnsembleLeg, филлы cross, спред Dukascopy. Два масштаба: (b) ОТНОСИТЕЛЬНЫЙ клон — scale такой,
// что средняя масштабированная цена ETH ≈ BTC/100k (та же геометрия tp/sl в % цены), из
// «круглых» {1000,2000,3000,5000,10000}; (a) масштаб пресета 10_000 (пипс = 1$). Контроль —
// тот же btc-matrend на BTC в том же окне. Окно март→21.09, train до 01.07, test с 01.07.
// Вердикт: stage1 — net > 0 на train И test; stage2 — test ≥ 10 сд и test net ≥ +10$.
(async () => {
const { EnsembleLeg } = await import('../../agent/ensemble');
const { ENSEMBLE_MEMBERS_BTC } = await import('../../agent/params');
const { loadM1WithSpread } = await import('../../backtest/data');
const fs = await import('node:fs');
const FROM = new Date('2026-03-01T00:00:00Z'), TO = new Date('2026-09-21T00:00:00Z'), SPLIT = new Date('2026-07-01T00:00:00Z');
const withBtc = process.argv.includes('--btc');
const base = ENSEMBLE_MEMBERS_BTC.find((m: any) => m.key === 'btc-matrend')!.params;
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
const fmt = (s: any) => `${s.n} сд net ${s.net >= 0 ? '+' : ''}${s.net}$ wr ${s.wr} exp ${s.exp} [${Object.entries(s.reasons).map(([k, v]) => `${k} ${v}`).join(' ')}]`;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
// спред: Dukascopy для крипты в 4-5 раз шире живого Exness (BTC live 1п=10$ против 50$ в истории),
// поэтому спред задаём моделью: BTC — живой замер 10$ (1п при scale 100k); ETH — 0.03% цены
// (≈2× живой относительный спред BTC, консервативно) и чувствительность 0.06%
async function run(label: string, instrument: string, baseSymbol: string, scale: number, spread: { frac?: number; abs?: number }) {
  const raw = await loadM1WithSpread(instrument, FROM, TO);
  const candles = raw.filter((c: any) => c.t >= FROM.getTime() && c.t < TO.getTime()).map((c: any) => ({ ...c, sp: spread.abs ?? c.c * (spread.frac ?? 0) }));
  const store = memStore();
  const leg: any = new EnsembleLeg({ store, isNewsBlackout: () => false }, { baseSymbol, crypto: true, warmup: null, fillMode: 'cross' }, [{ key: 'matrend', params: base }] as any);
  await leg.replayCandles(candles, scale, FROM);
  const rs = store.rows.filter((r: any) => r.symbol === `${baseSymbol}~matrend` && r.closedAt);
  const tr = stat(rs.filter((r: any) => r.openedAt < SPLIT)), te = stat(rs.filter((r: any) => r.openedAt >= SPLIT));
  const stage1 = tr.net > 0 && te.net > 0, stage2 = stage1 && te.n >= 10 && te.net >= 10;
  const sp = candles.filter((c: any) => c.sp).map((c: any) => c.sp / scale / 0.0001);
  console.log(`\n=== ${label}: scale ${scale}, ${candles.length} минуток, средняя масшт. цена ${mean(candles.map((c: any) => c.c / scale)).toFixed(3)}, средний спред ${mean(sp).toFixed(1)}п ===`);
  console.log(`  train ${fmt(tr)}\n  test  ${fmt(te)}\n  → stage1 ${stage1 ? '✅' : '—'} stage2 ${stage2 ? '✅' : '—'}`);
  return { label, instrument, scale, train: tr, test: te, stage1, stage2 };
}
const ethRaw = await loadM1WithSpread('ethusd', FROM, TO);
const ethTrainMean = mean(ethRaw.filter((c: any) => c.t < SPLIT.getTime()).map((c: any) => c.c));
let btcTrainMean = 100_000;
if (withBtc) { const { loadM1 } = await import('../../backtest/data'); const b = await loadM1('btcusd', FROM, TO); btcTrainMean = mean(b.filter((c: any) => c.t < SPLIT.getTime()).map((c: any) => c.c)); }
const target = 100_000 * ethTrainMean / btcTrainMean;
const relScale = [1000, 2000, 3000, 5000, 10000].reduce((a, b) => (Math.abs(Math.log(b / target)) < Math.abs(Math.log(a / target)) ? b : a));
console.log(`ETH средняя цена train ${ethTrainMean.toFixed(0)}$, BTC ${btcTrainMean.toFixed(0)}$ → относительный масштаб ${target.toFixed(0)} → ${relScale}`);
const results: any[] = [];
results.push(await run('ETH относительный клон (b), спред 0.03%', 'ethusd', 'ETH_USD', relScale, { frac: 0.0003 }));
results.push(await run('ETH относительный клон (b), спред 0.06% (чувствительность)', 'ethusd', 'ETH_USD', relScale, { frac: 0.0006 }));
if (relScale !== 10000) results.push(await run('ETH масштаб пресета (a), спред 0.03%', 'ethusd', 'ETH_USD', 10_000, { frac: 0.0003 }));
if (withBtc) results.push(await run('BTC контроль, спред 10$ (живой)', 'btcusd', 'BTC_USD', 100_000, { abs: 10 }));
fs.writeFileSync('data/stop-eth-2026-09-22/eth-clone-result.json', JSON.stringify({ ethTrainMean, btcTrainMean, relScale, results }, null, 1));
console.log('\nDONE'); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
