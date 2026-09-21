// P(win | условия входа) — логрег L2 на закрытых виртуальных сделках.
// Правила (зафиксированы ДО данных): цель win = pnl>0; фичи только известные при входе
// (сторона, час UTC, день недели, спред/вола на входе, BF-флаг, участник); сплит 70/30 по времени
// внутри группы; λ выбирается ТОЛЬКО внутри train (внутренний временной сплит);
// вердикт 1: OOS log-loss/AUC против базы «частота участника на train»;
// вердикт 2: экономический гейт «пропуск при P̂ < BE_wr ячейки» на test, p-value перестановкой внутри ячеек.
import * as fs from 'node:fs';

const SP = process.env.PWIN_DIR ?? 'data/pwin-2026-09-21'; // выгрузка agent_Trade (mode=virtual, closed) от 21.09.2026
type Row = { id: number; symbol: string; base: string; member: string; side: number; entry: number; sl: number; tp: number;
  openedAt: Date; pnl: number; bf: number; reason: string; spread: number; vol: number; hour: number; dow: number; y: number };

function load(): Row[] {
  const lines = fs.readFileSync(`${SP}/trades-virtual.psv`, 'utf8').trim().split('\n').slice(1);
  return lines.map(l => {
    const f = l.split('|');
    const [base, member] = f[1].split('~');
    const openedAt = new Date(f[8] + 'Z');
    return { id: +f[0], symbol: f[1], base, member, side: f[2] === 'BUY' ? 1 : -1, entry: +f[4], sl: +f[6], tp: +f[7],
      openedAt, pnl: +f[10], bf: +f[13], reason: f[14], spread: +f[15], vol: +f[16], hour: +f[17], dow: openedAt.getUTCDay(), y: +f[10] > 0 ? 1 : 0 };
  }).sort((a, b) => a.openedAt.getTime() - b.openedAt.getTime() || a.id - b.id);
}

const SHARED = ['side', 'hSin1', 'hCos1', 'hSin2', 'hCos2', 'Mon', 'Tue', 'Thu', 'Fri', 'Sat', 'Sun', 'lnSpread', 'lnVol', 'bf'];
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

function feats(r: Row, members: string[], med: Map<string, { spread: number; vol: number }>): number[] {
  const a = 2 * Math.PI * r.hour / 24;
  const m = med.get(r.base) ?? { spread: 1, vol: 1 };
  const dow = [1, 2, 4, 5, 6, 0].map(d => (r.dow === d ? 1 : 0));
  const mem = members.slice(1).map(k => (r.member === k ? 1 : 0));
  return [r.side, Math.sin(a), Math.cos(a), Math.sin(2 * a), Math.cos(2 * a), ...dow,
    Math.log((r.spread + 1e-6) / (m.spread + 1e-6)), Math.log((r.vol + 1e-9) / (m.vol + 1e-9)), r.bf, ...mem];
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
function fitLogReg(X: number[][], y: number[], lambda: number, iters = 3000, lr = 0.3) {
  const n = X.length, d = X[0].length;
  const w = new Array(d).fill(0); let b = 0;
  for (let it = 0; it < iters; it++) {
    const gw = new Array(d).fill(0); let gb = 0;
    for (let i = 0; i < n; i++) {
      let z = b; const x = X[i]; for (let j = 0; j < d; j++) z += x[j] * w[j];
      const e = sigmoid(z) - y[i];
      for (let j = 0; j < d; j++) gw[j] += e * x[j];
      gb += e;
    }
    for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / n + (lambda / n) * w[j]);
    b -= lr * (gb / n);
  }
  return { w, b };
}
const predict = (X: number[][], w: number[], b: number) => X.map(x => sigmoid(x.reduce((s, v, j) => s + v * w[j], b)));
const EPS = 1e-9;
const logloss = (P: number[], y: number[]) => P.reduce((s, p, i) => s - (y[i] * Math.log(Math.max(p, EPS)) + (1 - y[i]) * Math.log(Math.max(1 - p, EPS))), 0) / P.length;
function auc(P: number[], y: number[]): number {
  const idx = P.map((_, i) => i).sort((a, b) => P[a] - P[b]);
  // ранги со средними при ничьих
  const rank = new Array(P.length).fill(0);
  for (let i = 0; i < idx.length;) { let j = i; while (j + 1 < idx.length && P[idx[j + 1]] === P[idx[i]]) j++; const r = (i + j) / 2 + 1; for (let k = i; k <= j; k++) rank[idx[k]] = r; i = j + 1; }
  const n1 = y.filter(v => v === 1).length, n0 = y.length - n1;
  if (!n1 || !n0) return NaN;
  const sumR1 = y.reduce((s, v, i) => s + (v === 1 ? rank[i] : 0), 0);
  return (sumR1 - n1 * (n1 + 1) / 2) / (n1 * n0);
}
function standardize(X: number[][], mean?: number[], std?: number[]) {
  const d = X[0].length;
  const mu = mean ?? Array.from({ length: d }, (_, j) => X.reduce((s, x) => s + x[j], 0) / X.length);
  const sd = std ?? Array.from({ length: d }, (_, j) => Math.sqrt(X.reduce((s, x) => s + (x[j] - mu[j]) ** 2, 0) / Math.max(1, X.length - 1)) || 1);
  return { Z: X.map(x => x.map((v, j) => Math.max(-4, Math.min(4, (v - mu[j]) / sd[j])))), mean: mu, std: sd };
}

// mulberry32 — воспроизводимые перестановки
function rng(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

interface GroupResult {
  group: string; n: number; nTrain: number; nTest: number; splitAt: string; lambda: number;
  baseTrainWr: number; testWr: number;
  llConst: number; llMember: number; llModel: number; aucMember: number; aucModel: number;
  calib: Array<{ bin: string; n: number; pHat: number; wr: number }>;
  gate: Record<'nonBF' | 'all', { nTest: number; pnlAll: number; nSkip: number; pnlSkipped: number; pnlKept: number; permP: number; skippedWr: number; keptWr: number }>;
  gateQ: { nSkip: number; pnlSkipped: number; pnlKept: number; permP: number }; // вторичный: срез нижнего квинтиля P̂ (порог с train)
  coef: Record<string, number>;
}

function evalGroup(name: string, rows: Row[], frac: number, seed = 7): GroupResult {
  const nTrain = Math.floor(rows.length * frac);
  const train = rows.slice(0, nTrain), test = rows.slice(nTrain);
  const members = [...new Set(rows.map(r => r.member))].sort();
  const med = new Map<string, { spread: number; vol: number }>();
  for (const base of new Set(train.map(r => r.base))) {
    const rs = train.filter(r => r.base === base);
    med.set(base, { spread: median(rs.map(r => r.spread)), vol: median(rs.map(r => r.vol)) });
  }
  const Xtr = train.map(r => feats(r, members, med)), ytr = train.map(r => r.y);
  const Xte = test.map(r => feats(r, members, med)), yte = test.map(r => r.y);
  const st = standardize(Xtr);
  const Ztr = st.Z, Zte = standardize(Xte, st.mean, st.std).Z;
  // выбор λ строго внутри train: внутренний временной сплит 70/30
  const nIn = Math.floor(nTrain * 0.7);
  let best = { lambda: 10, ll: Infinity };
  for (const lambda of [1, 10, 100, 1000]) {
    const m = fitLogReg(Ztr.slice(0, nIn), ytr.slice(0, nIn), lambda);
    const ll = logloss(predict(Ztr.slice(nIn), m.w, m.b), ytr.slice(nIn));
    if (ll < best.ll) best = { lambda, ll };
  }
  const model = fitLogReg(Ztr, ytr, best.lambda);
  const P = predict(Zte, model.w, model.b);
  // базы
  const baseWr = ytr.reduce((s, v) => s + v, 0) / ytr.length;
  const memStat = new Map<string, { n: number; w: number; wins: number[]; losses: number[] }>();
  for (const r of train) {
    const s = memStat.get(r.member) ?? { n: 0, w: 0, wins: [], losses: [] };
    s.n++; s.w += r.y; (r.pnl > 0 ? s.wins : s.losses).push(Math.abs(r.pnl)); memStat.set(r.member, s);
  }
  const pMember = test.map(r => { const s = memStat.get(r.member); return s ? (s.w + 1) / (s.n + 2) : baseWr; });
  // калибровка по терцилям P̂ (границы — с train-предсказаний)
  const Ptr = predict(Ztr, model.w, model.b);
  const qs = [...Ptr].sort((a, b) => a - b);
  const q1 = qs[Math.floor(qs.length / 3)], q2 = qs[Math.floor(2 * qs.length / 3)], q20 = qs[Math.floor(qs.length / 5)];
  const calib = [['низ', (p: number) => p < q1], ['сред', (p: number) => p >= q1 && p < q2], ['верх', (p: number) => p >= q2]].map(([bin, f]) => {
    const ii = P.map((p, i) => i).filter(i => (f as (p: number) => boolean)(P[i]));
    return { bin: bin as string, n: ii.length, pHat: ii.length ? ii.reduce((s, i) => s + P[i], 0) / ii.length : NaN, wr: ii.length ? ii.reduce((s, i) => s + yte[i], 0) / ii.length : NaN };
  });
  // экономический гейт: BE_wr ячейки = avgLoss/(avgWin+avgLoss) по train (≥3 плюсов и ≥3 минусов), иначе по tp/sl сделки, иначе 0.5
  const beOf = (r: Row): number => {
    const s = memStat.get(r.member);
    if (s && s.wins.length >= 3 && s.losses.length >= 3) {
      const aw = s.wins.reduce((a, b) => a + b, 0) / s.wins.length, al = s.losses.reduce((a, b) => a + b, 0) / s.losses.length;
      return al / (aw + al);
    }
    const dt = Math.abs(r.tp - r.entry), ds = Math.abs(r.sl - r.entry);
    return dt > 0 && ds > 0 ? ds / (dt + ds) : 0.5;
  };
  const rnd = rng(seed);
  const runGate = (sel: (r: Row) => boolean, skipRule: (p: number, r: Row) => boolean) => {
    const ii = test.map((r, i) => i).filter(i => sel(test[i]));
    const skip = ii.filter(i => skipRule(P[i], test[i]));
    const kept = ii.filter(i => !skipRule(P[i], test[i]));
    const pnlAll = ii.reduce((s, i) => s + test[i].pnl, 0);
    const pnlSkipped = skip.reduce((s, i) => s + test[i].pnl, 0);
    const pnlKept = pnlAll - pnlSkipped;
    // перестановка: в каждой ячейке столько же случайных пропусков
    const byCell = new Map<string, number[]>();
    for (const i of ii) byCell.set(test[i].member, [...(byCell.get(test[i].member) ?? []), i]);
    const skipCount = new Map<string, number>();
    for (const i of skip) skipCount.set(test[i].member, (skipCount.get(test[i].member) ?? 0) + 1);
    let ge = 0; const REPS = 2000;
    for (let rep = 0; rep < REPS; rep++) {
      let keptR = pnlAll;
      for (const [cell, idxs] of byCell) {
        const k = skipCount.get(cell) ?? 0; if (!k) continue;
        const arr = [...idxs];
        for (let t = 0; t < k; t++) { const j = t + Math.floor(rnd() * (arr.length - t)); [arr[t], arr[j]] = [arr[j], arr[t]]; keptR -= test[arr[t]].pnl; }
      }
      if (keptR >= pnlKept - 1e-9) ge++;
    }
    const wr = (ids: number[]) => ids.length ? ids.reduce((s, i) => s + yte[i], 0) / ids.length : NaN;
    return { nTest: ii.length, pnlAll, nSkip: skip.length, pnlSkipped, pnlKept, permP: ge / REPS, skippedWr: wr(skip), keptWr: wr(kept) };
  };
  const beRule = (p: number, r: Row) => p < beOf(r);
  const gate = { nonBF: runGate(r => r.bf === 0, beRule), all: runGate(() => true, beRule) };
  const gq = runGate(r => r.bf === 0, p => p < q20);
  const coef: Record<string, number> = {};
  SHARED.forEach((k, j) => { coef[k] = model.w[j]; });
  return { group: name, n: rows.length, nTrain, nTest: test.length, splitAt: test[0].openedAt.toISOString().slice(0, 10), lambda: best.lambda,
    baseTrainWr: baseWr, testWr: yte.reduce((s, v) => s + v, 0) / yte.length,
    llConst: logloss(test.map(() => baseWr), yte), llMember: logloss(pMember, yte), llModel: logloss(P, yte),
    aucMember: auc(pMember, yte), aucModel: auc(P, yte), calib, gate,
    gateQ: { nSkip: gq.nSkip, pnlSkipped: gq.pnlSkipped, pnlKept: gq.pnlKept, permP: gq.permP }, coef };
}

const rows = load();
const RF = new Set(['SIBN', 'AFKS', 'GAZP', 'TRNFP', 'ALRS', 'SVCB', 'MOEX']);
const groups: Array<[string, Row[]]> = [
  ['BTC', rows.filter(r => r.base === 'BTC_USD')],
  ['WTI', rows.filter(r => r.base === 'WTICO_USD')],
  ['EUR', rows.filter(r => r.base === 'EUR_USD')],
  ['GBPJPY', rows.filter(r => r.base === 'GBP_JPY')],
  ['РФ-пул', rows.filter(r => RF.has(r.base))],
  ['ВСЁ (843)', rows],
];
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : 'n/a');
const d1 = (x: number) => (x >= 0 ? '+' : '') + x.toFixed(1);
const out: GroupResult[] = [];
const robust: Array<{ group: string; frac: number; dLL: number; auc: number; gateDelta: number; permP: number; nSkip: number; nTest: number; qDelta: number; qP: number; qSkip: number }> = [];
for (const [name, rs] of groups) {
  const g = evalGroup(name, rs, 0.7);
  out.push(g);
  console.log(`\n=== ${name}: n=${g.n} train=${g.nTrain} test=${g.nTest} (test с ${g.splitAt}), λ=${g.lambda}, WR train ${f2(g.baseTrainWr)} / test ${f2(g.testWr)}`);
  console.log(`  log-loss test: const ${f2(g.llConst)} | участник ${f2(g.llMember)} | модель ${f2(g.llModel)}  (Δ модель−участник ${(g.llModel - g.llMember >= 0 ? '+' : '')}${(g.llModel - g.llMember).toFixed(3)})`);
  console.log(`  AUC test: участник ${f2(g.aucMember)} | модель ${f2(g.aucModel)}`);
  console.log(`  калибровка по терцилям P̂ (train-границы): ${g.calib.map(c => `${c.bin} n=${c.n} P̂=${f2(c.pHat)} факт=${f2(c.wr)}`).join(' | ')}`);
  for (const k of ['nonBF', 'all'] as const) {
    const t = g.gate[k];
    console.log(`  гейт P̂<BE [${k}]: test ${t.nTest} сд, pnl ${d1(t.pnlAll)}$ → пропуск ${t.nSkip} сд (их pnl ${d1(t.pnlSkipped)}$, WR ${f2(t.skippedWr)}), остаток ${d1(t.pnlKept)}$ (WR ${f2(t.keptWr)}), perm-p ${t.permP.toFixed(3)}`);
  }
  console.log(`  вторичный гейт «нижний квинтиль P̂» [nonBF]: пропуск ${g.gateQ.nSkip}, их pnl ${d1(g.gateQ.pnlSkipped)}$, остаток ${d1(g.gateQ.pnlKept)}$, perm-p ${g.gateQ.permP.toFixed(3)}`);
  const top = Object.entries(g.coef).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 6).map(([k, v]) => `${k} ${v >= 0 ? '+' : ''}${v.toFixed(2)}`);
  console.log(`  веса (станд.): ${top.join(', ')}`);
  for (const frac of [0.6, 0.7, 0.8]) {
    const r = frac === 0.7 ? g : evalGroup(name, rs, frac);
    robust.push({ group: name, frac, dLL: r.llModel - r.llMember, auc: r.aucModel, gateDelta: r.gate.nonBF.pnlKept - r.gate.nonBF.pnlAll, permP: r.gate.nonBF.permP, nSkip: r.gate.nonBF.nSkip, nTest: r.gate.nonBF.nTest, qDelta: -r.gateQ.pnlSkipped, qP: r.gateQ.permP, qSkip: r.gateQ.nSkip });
  }
}
console.log('\n=== устойчивость к точке сплита (nonBF): группа | frac | Δlog-loss vs участник | AUC | BE-гейт: Δpnl, perm-p, пропуск/test | квинтиль-гейт: Δpnl, perm-p, пропуск');
for (const r of robust) console.log(`  ${r.group.padEnd(10)} ${r.frac}  ${(r.dLL >= 0 ? '+' : '') + r.dLL.toFixed(3)}  ${f2(r.auc)}  | BE ${d1(r.gateDelta)}$ p=${r.permP.toFixed(3)} ${r.nSkip}/${r.nTest} | Q20 ${d1(r.qDelta)}$ p=${r.qP.toFixed(3)} ${r.qSkip}`);

// описательная картина по условиям (вся выборка, для интерпретации — не для вердикта)
console.log('\n=== описательно (вся выборка): WR по терцилям спреда / волы, по сессиям, по стороне');
for (const [name, rs] of groups) {
  const wr = (xs: Row[]) => (xs.length ? `${(xs.reduce((s, r) => s + r.y, 0) / xs.length).toFixed(2)}(${xs.length})` : '—');
  const terc = (key: (r: Row) => number) => {
    // терцили внутри инструмента (разные масштабы спреда/волы)
    const lo: Row[] = [], mid: Row[] = [], hi: Row[] = [];
    for (const base of new Set(rs.map(r => r.base))) {
      const xs = rs.filter(r => r.base === base); const v = xs.map(key).sort((a, b) => a - b);
      const a = v[Math.floor(v.length / 3)], b = v[Math.floor(2 * v.length / 3)];
      for (const r of xs) (key(r) < a ? lo : key(r) < b ? mid : hi).push(r);
    }
    return `${wr(lo)} / ${wr(mid)} / ${wr(hi)}`;
  };
  const sess = (a: number, b: number) => wr(rs.filter(r => r.hour >= a && r.hour < b));
  console.log(`  ${name.padEnd(10)} спред ${terc(r => r.spread)} | вола ${terc(r => r.vol)} | сессии 0-7 ${sess(0, 7)} 7-13 ${sess(7, 13)} 13-21 ${sess(13, 21)} 21-24 ${sess(21, 24)} | BUY ${wr(rs.filter(r => r.side > 0))} SELL ${wr(rs.filter(r => r.side < 0))} | BF ${wr(rs.filter(r => r.bf === 1))} live ${wr(rs.filter(r => r.bf === 0))}`);
}
fs.writeFileSync(`${SP}/pwin-result.json`, JSON.stringify({ when: new Date().toISOString(), groups: out, robust }, null, 1));
