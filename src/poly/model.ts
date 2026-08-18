// Fair-модель 5-минуток Polymarket (план M5): P(up) бакета по микроструктуре
// минуток BTC-USD. Логистическая регрессия руками, walk-forward по времени,
// вердикт по кумулятивному порогу леджера Бонферрони (см. miner2).
//
// Честная рамка (после M4): исходы — монетка (UP 51.0%, автокорреляции нет),
// ожидание скромное; rejected — НЕ провал итерации, дашборд покажет «без скоса».
// Батч гипотез ЗАФИКСИРОВАН до прогона: 3 конфигурации λ ∈ {0.1, 1, 10} — выбор
// по внутренней валидации хвостом трейна, тест трогается ОДИН раз.
//
// Оговорка об источниках: таргет резолвится по Chainlink/Pyth TWAP-60с, фичи —
// по CFD-котировке Dukascopy; расхождение источников — шум таргета, не утечка.
//
// CLI: npx tsx src/poly/model.ts [--train-end 2026-08-16] [--out data/poly-model.json]

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadM1 } from '../backtest/data';
import { loadHist } from './harvest';

export const FEATURE_NAMES = ['ret1', 'mom3', 'mom5', 'drift5', 'volRatio', 'prevOut'] as const;

export interface PolyModelFile {
  featureNames: string[];
  mean: number[];        // стандартизация по трейну
  std: number[];
  volMedTrain: number;   // медиана vol30 трейна — нормировка volRatio
  weights: number[];
  bias: number;
  lambda: number;
  nTrain: number;
  nTest: number;
  metrics: {
    baseRateTrain: number;
    train: { logloss: number; loglossBase: number; acc: number };
    test: { logloss: number; loglossBase: number; acc: number; accBase: number; tPaired: number; zAcc: number };
  };
  bonferroni: { cumulativeN: number; batchN: number; alpha: number; zThreshold: number };
  verdict: 'licensed' | 'rejected';
  trainedAt: string;
  note: string;
}

interface RawSample {
  t0: number;            // unix сек начала бакета
  y: 0 | 1;
  ret1: number;
  mom3: number;
  mom5: number;
  drift5: number;
  vol30: number;         // сырая вола — volRatio считается после сплита
  prevOut: number;       // −1|0|+1
}

const ln = Math.log;

export async function buildDataset(asset: string, from: Date, to: Date): Promise<RawSample[]> {
  const hist = [...loadHist(asset).values()]
    .filter(h => !h.missing && h.outcome)
    .sort((a, b) => a.ts - b.ts);
  const candles = await loadM1('btcusd', from, to, 'bid');
  const byT = new Map<number, { o: number; c: number }>();
  for (const c of candles) byT.set(c.t, { o: c.o, c: c.c });
  const prevOutcome = new Map<number, string>();
  for (const h of hist) prevOutcome.set(h.ts, h.outcome!);

  const out: RawSample[] = [];
  for (const h of hist) {
    const t0 = h.ts;
    // закрытая минутка k минут назад: бар, начавшийся в t0−k·60с
    const bar = (k: number) => byT.get((t0 - k * 60) * 1000);
    const b1 = bar(1);
    const b2 = bar(2);
    const b4 = bar(4);
    const b6 = bar(6);
    const b5 = bar(5); // open прошлого бакета
    if (!b1 || !b2 || !b4 || !b6 || !b5) continue;
    // vol30: σ минутных лог-возвратов из окна 30 мин (≥20 последовательных пар)
    const rets: number[] = [];
    for (let k = 31; k >= 2; k--) {
      const a = bar(k);
      const b = bar(k - 1);
      if (a && b && a.c > 0 && b.c > 0) rets.push(ln(b.c / a.c));
    }
    if (rets.length < 20) continue;
    const m = rets.reduce((s, x) => s + x, 0) / rets.length;
    const vol30 = Math.sqrt(rets.reduce((s, x) => s + (x - m) ** 2, 0) / (rets.length - 1));
    if (!(vol30 > 0)) continue;
    const po = prevOutcome.get(t0 - 300);
    out.push({
      t0,
      y: h.outcome === 'up' ? 1 : 0,
      ret1: ln(b1.c / b2.c) / vol30,
      mom3: ln(b1.c / b4.c) / (vol30 * Math.sqrt(3)),
      mom5: ln(b1.c / b6.c) / (vol30 * Math.sqrt(5)),
      drift5: ln(b1.c / b5.o) / (vol30 * Math.sqrt(5)),
      vol30,
      prevOut: po ? (po === 'up' ? 1 : -1) : 0,
    });
  }
  return out;
}

function toXY(rows: RawSample[], volMed: number): { X: number[][]; y: number[] } {
  return {
    X: rows.map(r => [r.ret1, r.mom3, r.mom5, r.drift5, ln(r.vol30 / volMed), r.prevOut]),
    y: rows.map(r => r.y),
  };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

export function fitLogReg(X: number[][], y: number[], lambda: number, iters = 4000, lr = 0.5) {
  const n = X.length;
  const d = X[0].length;
  let w = new Array(d).fill(0);
  let b = 0;
  for (let it = 0; it < iters; it++) {
    const gw = new Array(d).fill(0);
    let gb = 0;
    for (let i = 0; i < n; i++) {
      const p = sigmoid(X[i].reduce((s, x, j) => s + x * w[j], b));
      const e = p - y[i];
      for (let j = 0; j < d; j++) gw[j] += e * X[i][j];
      gb += e;
    }
    for (let j = 0; j < d; j++) w[j] = w[j] - lr * (gw[j] / n + (lambda / n) * w[j]);
    b -= lr * (gb / n);
  }
  return { w, b };
}

function predictP(X: number[][], w: number[], b: number): number[] {
  return X.map(x => sigmoid(x.reduce((s, v, j) => s + v * w[j], b)));
}

const EPS = 1e-9;
const sampleLoss = (p: number, y: number) => -(y * ln(Math.max(p, EPS)) + (1 - y) * ln(Math.max(1 - p, EPS)));
const logloss = (P: number[], y: number[]) => P.reduce((s, p, i) => s + sampleLoss(p, y[i]), 0) / P.length;

function standardize(X: number[][], mean?: number[], std?: number[]) {
  const d = X[0].length;
  const mu = mean ?? Array.from({ length: d }, (_, j) => X.reduce((s, x) => s + x[j], 0) / X.length);
  const sd = std ?? Array.from({ length: d }, (_, j) => {
    const v = X.reduce((s, x) => s + (x[j] - mu[j]) ** 2, 0) / Math.max(1, X.length - 1);
    return Math.sqrt(v) || 1;
  });
  return { Z: X.map(x => x.map((v, j) => (v - mu[j]) / sd[j])), mean: mu, std: sd };
}

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  (async () => {
    const trainEnd = Math.floor(new Date(arg('train-end', '2026-08-16') + 'T00:00:00Z').getTime() / 1000);
    const outFile = arg('out', 'data/poly-model.json');
    const LAMBDAS = [0.1, 1, 10]; // батч зафиксирован ДО прогона: 3 гипотезы

    const rows = await buildDataset('btc', new Date('2026-08-10T00:00:00Z'), new Date());
    const train = rows.filter(r => r.t0 < trainEnd);
    const test = rows.filter(r => r.t0 >= trainEnd);
    console.log(`датасет: ${rows.length} бакетов с полными фичами (train ${train.length} · test ${test.length})`);
    if (train.length < 300 || test.length < 100) throw new Error('датасет слишком мал');

    const volMed = median(train.map(r => r.vol30));
    const tr = toXY(train, volMed);
    const te = toXY(test, volMed);

    // внутренняя валидация: первые 80% трейна → фит, хвост 20% → выбор λ
    const cut = Math.floor(train.length * 0.8);
    const trFitStd = standardize(tr.X.slice(0, cut));
    const valZ = tr.X.slice(cut).map(x => x.map((v, j) => (v - trFitStd.mean[j]) / trFitStd.std[j]));
    const valY = tr.y.slice(cut);
    let bestLambda = LAMBDAS[0];
    let bestVal = Infinity;
    for (const lam of LAMBDAS) {
      const { w, b } = fitLogReg(trFitStd.Z, tr.y.slice(0, cut), lam);
      const ll = logloss(predictP(valZ, w, b), valY);
      console.log(`  λ=${lam}: val logloss ${ll.toFixed(5)}`);
      if (ll < bestVal) { bestVal = ll; bestLambda = lam; }
    }

    // финальный фит на всём трейне; тест — один раз
    const full = standardize(tr.X);
    const { w, b } = fitLogReg(full.Z, tr.y, bestLambda);
    const teZ = te.X.map(x => x.map((v, j) => (v - full.mean[j]) / full.std[j]));
    const pTrain = predictP(full.Z, w, b);
    const pTest = predictP(teZ, w, b);

    const baseRate = tr.y.reduce((s, v) => s + v, 0) / tr.y.length;
    const llTrain = logloss(pTrain, tr.y);
    const llTrainBase = logloss(tr.y.map(() => baseRate), tr.y);
    const llTest = logloss(pTest, te.y);
    const llTestBase = logloss(te.y.map(() => baseRate), te.y);
    const accTrain = pTrain.filter((p, i) => (p >= 0.5 ? 1 : 0) === tr.y[i]).length / pTrain.length;
    const accTest = pTest.filter((p, i) => (p >= 0.5 ? 1 : 0) === te.y[i]).length / pTest.length;
    const accBase = Math.max(baseRate, 1 - baseRate);

    // paired t по разности per-sample loss (base − model): >0 = модель лучше
    const diffs = pTest.map((p, i) => sampleLoss(baseRate, te.y[i]) - sampleLoss(p, te.y[i]));
    const dm = diffs.reduce((s, x) => s + x, 0) / diffs.length;
    const dsd = Math.sqrt(diffs.reduce((s, x) => s + (x - dm) ** 2, 0) / (diffs.length - 1)) || 1;
    const tPaired = dm / (dsd / Math.sqrt(diffs.length));
    const zAcc = (accTest - accBase) / Math.sqrt((accBase * (1 - accBase)) / te.y.length);

    // кумулятивный порог Бонферрони: z для alpha/2 хвоста при alpha=0.05/(N+батч)
    const ledger = JSON.parse(readFileSync('data/hypothesis-ledger.json', 'utf8'));
    const cumulativeN = (ledger.totalTested as number) + LAMBDAS.length;
    const alpha = 0.05 / cumulativeN;
    // квантиль нормали через поиск (нет jstat): z: P(Z>z)=alpha
    let lo = 0, hi = 10;
    const tailP = (z: number) => 0.5 * Math.exp(-0.717 * z - 0.416 * z * z); // аппроксимация хвоста (достаточно для порога)
    while (hi - lo > 1e-4) { const mid = (lo + hi) / 2; if (tailP(mid) > alpha) lo = mid; else hi = mid; }
    const zThreshold = (lo + hi) / 2;

    const verdict: PolyModelFile['verdict'] = tPaired >= zThreshold && llTest < llTestBase ? 'licensed' : 'rejected';

    const model: PolyModelFile = {
      featureNames: [...FEATURE_NAMES],
      mean: full.mean, std: full.std, volMedTrain: volMed,
      weights: w, bias: b, lambda: bestLambda,
      nTrain: train.length, nTest: test.length,
      metrics: {
        baseRateTrain: +baseRate.toFixed(4),
        train: { logloss: +llTrain.toFixed(5), loglossBase: +llTrainBase.toFixed(5), acc: +accTrain.toFixed(4) },
        test: {
          logloss: +llTest.toFixed(5), loglossBase: +llTestBase.toFixed(5),
          acc: +accTest.toFixed(4), accBase: +accBase.toFixed(4),
          tPaired: +tPaired.toFixed(3), zAcc: +zAcc.toFixed(3),
        },
      },
      bonferroni: { cumulativeN, batchN: LAMBDAS.length, alpha, zThreshold: +zThreshold.toFixed(2) },
      verdict,
      trainedAt: new Date().toISOString(),
      note: 'Таргет: Chainlink/Pyth TWAP-60с; фичи: Dukascopy CFD (расхождение источников — шум таргета). Исходы по M4 — монетка.',
    };
    writeFileSync(outFile, JSON.stringify(model, null, 2));
    console.log(`\nλ*=${bestLambda} · веса: ${FEATURE_NAMES.map((f, j) => `${f}=${w[j].toFixed(3)}`).join(' ')} · bias=${b.toFixed(3)}`);
    console.log(`train: logloss ${llTrain.toFixed(5)} (база ${llTrainBase.toFixed(5)}) · acc ${(accTrain * 100).toFixed(1)}%`);
    console.log(`test:  logloss ${llTest.toFixed(5)} (база ${llTestBase.toFixed(5)}) · acc ${(accTest * 100).toFixed(1)}% (база ${(accBase * 100).toFixed(1)}%)`);
    console.log(`t(paired) ${tPaired.toFixed(3)} · z(acc) ${zAcc.toFixed(3)} · порог Бонферрони z≥${zThreshold.toFixed(2)} (N=${cumulativeN})`);
    console.log(`ВЕРДИКТ: ${verdict.toUpperCase()}`);
    console.log(`→ ${outFile}`);
    process.exit(0);
  })().catch(e => {
    console.error(e);
    process.exit(1);
  });
}
