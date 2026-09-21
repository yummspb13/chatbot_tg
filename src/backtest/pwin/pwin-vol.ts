// Пост-хок проверка (родилась из описательной таблицы pwin-model: низкая вола на входе → низкий WR у WTI/GBPJPY/EUR).
// Правило ОДНО: «пропуск входа, если volAtEntry ниже нижнего терциля инструмента по train». Граница — только с train,
// вердикт — на тех же 30% test, что и у модели; перестановка внутри ячеек; заявляется как пост-хок (6 групп × 1 правило).
import * as fs from 'node:fs';
const SP = process.env.PWIN_DIR ?? 'data/pwin-2026-09-21';
type Row = { id: number; base: string; member: string; openedAt: Date; pnl: number; bf: number; reason: string; vol: number; y: number };
const rows: Row[] = fs.readFileSync(`${SP}/trades-virtual.psv`, 'utf8').trim().split('\n').slice(1).map(l => {
  const f = l.split('|'); const [base, member] = f[1].split('~');
  return { id: +f[0], base, member, openedAt: new Date(f[8] + 'Z'), pnl: +f[10], bf: +f[13], reason: f[14], vol: +f[16], y: +f[10] > 0 ? 1 : 0 };
}).sort((a, b) => a.openedAt.getTime() - b.openedAt.getTime() || a.id - b.id);
function rng(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const RF = new Set(['SIBN', 'AFKS', 'GAZP', 'TRNFP', 'ALRS', 'SVCB', 'MOEX']);
const groups: Array<[string, Row[]]> = [
  ['BTC', rows.filter(r => r.base === 'BTC_USD')], ['WTI', rows.filter(r => r.base === 'WTICO_USD')], ['EUR', rows.filter(r => r.base === 'EUR_USD')],
  ['GBPJPY', rows.filter(r => r.base === 'GBP_JPY')], ['РФ-пул', rows.filter(r => RF.has(r.base))], ['ВСЁ', rows],
];
const wr = (xs: Row[]) => (xs.length ? (xs.reduce((s, r) => s + r.y, 0) / xs.length).toFixed(2) : '—');
const sum = (xs: Row[]) => xs.reduce((s, r) => s + r.pnl, 0);
const d1 = (x: number) => (x >= 0 ? '+' : '') + x.toFixed(1);
function permP(test: Row[], skip: Set<number>, seed = 11): number {
  const byCell = new Map<string, Row[]>(); for (const r of test) byCell.set(r.member, [...(byCell.get(r.member) ?? []), r]);
  const kCell = new Map<string, number>(); for (const r of test) if (skip.has(r.id)) kCell.set(r.member, (kCell.get(r.member) ?? 0) + 1);
  const obsSkipped = sum(test.filter(r => skip.has(r.id)));
  const rnd = rng(seed); let le = 0; const REPS = 4000;
  for (let rep = 0; rep < REPS; rep++) {
    let s = 0;
    for (const [cell, xs] of byCell) { const k = kCell.get(cell) ?? 0; if (!k) continue; const a = [...xs]; for (let t = 0; t < k; t++) { const j = t + Math.floor(rnd() * (a.length - t)); [a[t], a[j]] = [a[j], a[t]]; s += a[t].pnl; } }
    if (s <= obsSkipped + 1e-9) le++; // случайный пропуск теряет не больше, чем наш → наш не лучше случайного
  }
  return le / REPS; // p = P(случайные пропуски того же счёта убирают ≤ pnl, чем правило): маленькое p = правило убирает именно минус
}
console.log('правило: пропуск при vol < нижнего терциля инструмента (граница по train). Формат: train WR low/rest → test: low n, WR, pnl (что пропустили) | rest n, WR, pnl | perm-p');
for (const frac of [0.7, 0.6, 0.8]) {
  console.log(`\n--- frac ${frac} ---`);
  for (const [name, rs] of groups) {
    const nTr = Math.floor(rs.length * frac); const train = rs.slice(0, nTr), test = rs.slice(nTr).filter(r => r.bf === 0);
    const lo = new Map<string, number>();
    for (const base of new Set(train.map(r => r.base))) { const v = train.filter(r => r.base === base).map(r => r.vol).sort((a, b) => a - b); lo.set(base, v[Math.floor(v.length / 3)]); }
    const isLow = (r: Row) => r.vol < (lo.get(r.base) ?? -Infinity);
    const trLow = train.filter(isLow), trRest = train.filter(r => !isLow(r));
    const teLow = test.filter(isLow), teRest = test.filter(r => !isLow(r));
    const p = teLow.length ? permP(test, new Set(teLow.map(r => r.id))) : NaN;
    console.log(`  ${name.padEnd(7)} train ${wr(trLow)}(${trLow.length})/${wr(trRest)}(${trRest.length}) → test: low ${teLow.length} WR ${wr(teLow)} pnl ${d1(sum(teLow))}$ | rest ${teRest.length} WR ${wr(teRest)} pnl ${d1(sum(teRest))}$ | perm-p ${Number.isFinite(p) ? p.toFixed(3) : 'n/a'}`);
  }
}
console.log('\n--- диагностика (вся выборка, без BF): исходы low-vol vs rest по причинам закрытия ---');
for (const [name, rs0] of groups) {
  const rs = rs0.filter(r => r.bf === 0);
  const lo = new Map<string, number>();
  for (const base of new Set(rs.map(r => r.base))) { const v = rs.filter(r => r.base === base).map(r => r.vol).sort((a, b) => a - b); lo.set(base, v[Math.floor(v.length / 3)]); }
  const mix = (xs: Row[]) => { const m = new Map<string, number>(); for (const r of xs) m.set(r.reason || '?', (m.get(r.reason || '?') ?? 0) + 1); return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${(100 * v / xs.length).toFixed(0)}%`).join(' '); };
  const low = rs.filter(r => r.vol < (lo.get(r.base) ?? -Infinity)), rest = rs.filter(r => !(r.vol < (lo.get(r.base) ?? -Infinity)));
  console.log(`  ${name.padEnd(7)} low(${low.length}) WR ${wr(low)} avg ${(sum(low) / Math.max(1, low.length)).toFixed(2)}$: ${mix(low)} || rest(${rest.length}) WR ${wr(rest)} avg ${(sum(rest) / Math.max(1, rest.length)).toFixed(2)}$: ${mix(rest)}`);
}
