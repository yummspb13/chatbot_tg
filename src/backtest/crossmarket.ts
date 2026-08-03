// Межрыночные связки (lead-lag): состояние рынка A → сделка в рынке B.
//
// Семейство, которое мы ещё не трогали: S&P как risk-прокси для GBPJPY и золота,
// EUR/USD как долларовый лидер для золота и кросса, BTC (торгует 24/7) как
// опережающий индикатор индекса и золота. Минутные lead-lag сильно выарбитражены —
// prior низкий, поэтому дисциплина максимальная, как в майнере:
//   этап 1 — скрининг гипотез на майнинговом окне с Бонферрони;
//   этап 2 — стратегизация выживших (train 60% / val 40%), рыночный вход с
//            реальным полуспредом момента, tp/sl фикс, тайм-выход по горизонту;
//   этап 3 — одноразовый сейф 2026-05-01 → 2026-07-30.
//
// Состояния A (на закрытом M15-баре, не старше 2ч — иначе «лидерство» фиктивно):
//   up/down       — знак последнего бара;
//   upup/downdown — два подряд одного знака;
//   bigup/bigdown — |ход| ≥ 3×mult_A пипсов.
// Исход B: знаковый ход следующих 1 или 4 M15-баров.
//
// CLI: npx tsx src/backtest/crossmarket.ts

import { pathToFileURL } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PIP } from '../broker/types';
import { Candle, loadM1WithSpread } from './data';
import { MARKETS, prepCandles } from './runner';

function normalQuantile(p: number): number {
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pl = 0.02425;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= 1 - pl) {
    const q = p - 0.5;
    const r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

function tStat(xs: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const mean = xs.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1));
  return sd > 0 ? mean / (sd / Math.sqrt(n)) : 0;
}

// ---------------------------------------------------------------- бары

const M15 = 900_000;

interface Bar {
  t: number;  // начало M15-окна
  o: number;
  h: number;
  l: number;
  c: number;
  sp: number; // средний спред окна
  m1From: number; // индекс первой M1-минутки бара (для симуляции сделок)
}

function toM15(m1: Candle[]): Bar[] {
  const out: Bar[] = [];
  let cur: Bar | null = null;
  let spSum = 0;
  let spN = 0;
  for (let i = 0; i < m1.length; i++) {
    const c = m1[i];
    const bucket = Math.floor(c.t / M15) * M15;
    if (!cur || cur.t !== bucket) {
      if (cur) {
        cur.sp = spN ? spSum / spN : PIP;
        out.push(cur);
      }
      cur = { t: bucket, o: c.o, h: c.h, l: c.l, c: c.c, sp: PIP, m1From: i };
      spSum = 0;
      spN = 0;
    } else {
      cur.h = Math.max(cur.h, c.h);
      cur.l = Math.min(cur.l, c.l);
      cur.c = c.c;
    }
    if (c.sp !== undefined) {
      spSum += c.sp;
      spN += 1;
    }
  }
  if (cur) {
    cur.sp = spN ? spSum / spN : PIP;
    out.push(cur);
  }
  return out;
}

interface Mkt {
  key: string;
  mult: number;
  m1: Candle[];
  bars: Bar[];
  barByT: Map<number, number>; // t → индекс
}

async function loadMkt(key: string, from: Date, to: Date): Promise<Mkt> {
  const spec = MARKETS[key];
  const m1 = prepCandles(await loadM1WithSpread(spec.instrument, from, to), spec);
  const bars = toM15(m1);
  return {
    key,
    mult: spec.pipsMult ?? 1,
    m1,
    bars,
    barByT: new Map(bars.map((b, i) => [b.t, i])),
  };
}

type StateKey = 'up' | 'down' | 'upup' | 'downdown' | 'bigup' | 'bigdown';

/** Состояние A по закрытому бару с t = tB − 15м (свежесть ≤ 2ч проверяет вызывающий). */
function stateOf(a: Mkt, idx: number): StateKey[] {
  const bar = a.bars[idx];
  const ret = bar.c - bar.o;
  const out: StateKey[] = [ret >= 0 ? 'up' : 'down'];
  if (idx > 0) {
    const prev = a.bars[idx - 1];
    if (ret >= 0 && prev.c - prev.o >= 0) out.push('upup');
    if (ret < 0 && prev.c - prev.o < 0) out.push('downdown');
  }
  if (Math.abs(ret) >= 3 * a.mult * PIP) out.push(ret >= 0 ? 'bigup' : 'bigdown');
  return out;
}

/** Последний ЗАКРЫТЫЙ бар A к началу бара B (не старше 2ч). */
function lastClosedA(a: Mkt, tB: number): number | -1 {
  for (let k = 1; k <= 8; k++) { // до 2ч назад по сетке M15
    const idx = a.barByT.get(tB - k * M15);
    if (idx !== undefined) return idx;
  }
  return -1;
}

// ---------------------------------------------------------------- симуляция сделки в B (M1-точность)

function simTrade(b: Mkt, bar: Bar, side: 'BUY' | 'SELL', tpPips: number, slPips: number, horizonMs: number): number | null {
  const i0 = bar.m1From;
  const c0 = b.m1[i0];
  if (!c0) return null;
  const half0 = (c0.sp ?? PIP) / 2;
  const entry = side === 'BUY' ? c0.c + half0 : c0.c - half0;
  const tp = side === 'BUY' ? entry + tpPips * PIP : entry - tpPips * PIP;
  const sl = side === 'BUY' ? entry - slPips * PIP : entry + slPips * PIP;
  const deadline = bar.t + M15 + horizonMs;
  for (let i = i0 + 1; i < b.m1.length; i++) {
    const c = b.m1[i];
    const half = (c.sp ?? PIP) / 2;
    if (side === 'BUY') {
      if (c.l - half <= sl) return (sl - entry) * 1000;
      if (c.h - half >= tp) return (tp - entry) * 1000;
    } else {
      if (c.h + half >= sl) return (entry - sl) * 1000;
      if (c.l + half <= tp) return (entry - tp) * 1000;
    }
    if (c.t >= deadline) {
      const exit = side === 'BUY' ? c.c - half : c.c + half;
      return (side === 'BUY' ? exit - entry : entry - exit) * 1000;
    }
    if (c.t - bar.t > 48 * 3600_000) break; // сессионный разрыв — сделки нет смысла тянуть
  }
  return null;
}

// ---------------------------------------------------------------- главный прогон

const PAIRS: Array<{ a: string; b: string }> = [
  { a: 'usa500idxusd', b: 'gbpjpy' },
  { a: 'usa500idxusd', b: 'xauusd' },
  { a: 'eurusd', b: 'xauusd' },
  { a: 'eurusd', b: 'gbpjpy' },
  { a: 'btcusd', b: 'usa500idxusd' },
  { a: 'btcusd', b: 'xauusd' },
];
const STATES: StateKey[] = ['up', 'down', 'upup', 'downdown', 'bigup', 'bigdown'];
const HORIZONS = [1, 4]; // M15-баров

function parseArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  (async () => {
    const from = new Date(parseArg('from') ?? '2024-01-01');
    const lockboxFrom = new Date(parseArg('lockbox') ?? '2026-05-01');
    const to = new Date(parseArg('to') ?? '2026-07-30');

    const keys = [...new Set(PAIRS.flatMap(p => [p.a, p.b]))];
    const mkts = new Map<string, Mkt>();
    for (const k of keys) {
      mkts.set(k, await loadMkt(k, from, to));
      console.log(`${k}: ${mkts.get(k)!.bars.length} M15-баров`);
    }

    const nHyp = PAIRS.length * STATES.length * HORIZONS.length;
    const zBonf = normalQuantile(1 - (0.05 / nHyp) / 2);
    console.log(`\nЭтап 1: гипотез ${nHyp}, Бонферрони |t|≥${zBonf.toFixed(2)} (майнинг до ${lockboxFrom.toISOString().slice(0, 10)})\n`);

    interface Hyp {
      pair: typeof PAIRS[0];
      state: StateKey;
      h: number;
      mean: number;
      t: number;
      n: number;
    }
    const survivors: Hyp[] = [];
    for (const pair of PAIRS) {
      const A = mkts.get(pair.a)!;
      const B = mkts.get(pair.b)!;
      for (const state of STATES) {
        for (const h of HORIZONS) {
          const rets: number[] = [];
          for (let i = 0; i + h < B.bars.length; i++) {
            const bar = B.bars[i];
            if (bar.t >= lockboxFrom.getTime()) break; // сейф не трогаем
            const aIdx = lastClosedA(A, bar.t);
            if (aIdx < 0) continue;
            if (!stateOf(A, aIdx).includes(state)) continue;
            const fwd = (B.bars[i + h].c - bar.o) / (B.mult * PIP); // от открытия бара B
            rets.push(fwd);
          }
          if (rets.length < 300) continue;
          const t = tStat(rets);
          if (Math.abs(t) >= zBonf) {
            const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
            survivors.push({ pair, state, h, mean, t, n: rets.length });
          }
        }
      }
    }
    survivors.sort((x, y) => Math.abs(y.t) - Math.abs(x.t));
    console.log(`Выжило: ${survivors.length}`);
    for (const s of survivors.slice(0, 20)) {
      console.log(`  ${s.pair.a}[${s.state}] → ${s.pair.b} h${s.h}: mean ${s.mean >= 0 ? '+' : ''}${s.mean.toFixed(2)}п×mult, t=${s.t.toFixed(2)}, n=${s.n}`);
    }

    // Этап 2: стратегизация топ-10 (по |t|), рыночный вход, tp20/sl40 ×mult B, тайм-выход = горизонт
    console.log('\nЭтап 2: train 60% / val 40% майнингового окна');
    interface RuleRes {
      hyp: Hyp;
      side: 'BUY' | 'SELL';
      train: number;
      trainN: number;
      val: number;
      valN: number;
      pass: boolean;
    }
    const finalists: RuleRes[] = [];
    for (const hyp of survivors.slice(0, 10)) {
      const A = mkts.get(hyp.pair.a)!;
      const B = mkts.get(hyp.pair.b)!;
      const side: 'BUY' | 'SELL' = hyp.mean > 0 ? 'BUY' : 'SELL';
      const pnls: Array<{ t: number; pnl: number }> = [];
      let busyUntil = 0;
      for (let i = 0; i < B.bars.length; i++) {
        const bar = B.bars[i];
        if (bar.t >= lockboxFrom.getTime()) break;
        if (bar.t < busyUntil) continue;
        const aIdx = lastClosedA(A, bar.t);
        if (aIdx < 0 || !stateOf(A, aIdx).includes(hyp.state)) continue;
        const pnl = simTrade(B, bar, side, 20 * B.mult, 40 * B.mult, hyp.h * M15);
        if (pnl === null) continue;
        pnls.push({ t: bar.t, pnl });
        busyUntil = bar.t + M15 + hyp.h * M15;
      }
      const cut = Math.floor(pnls.length * 0.6);
      const train = pnls.slice(0, cut).reduce((s, x) => s + x.pnl, 0);
      const val = pnls.slice(cut).reduce((s, x) => s + x.pnl, 0);
      const res: RuleRes = {
        hyp, side,
        train: +train.toFixed(2), trainN: cut,
        val: +val.toFixed(2), valN: pnls.length - cut,
        pass: train > 0 && val > 0,
      };
      finalists.push(res);
      console.log(`  ${res.pass ? '✅' : '❌'} ${hyp.pair.a}[${hyp.state}]→${hyp.pair.b} h${hyp.h} (${side}): `
        + `train ${res.train}$ (${res.trainN} сд) / val ${res.val}$ (${res.valN} сд)`);
    }

    // Этап 3: сейф — одноразово
    console.log(`\nЭтап 3: сейф (${lockboxFrom.toISOString().slice(0, 10)} → ${to.toISOString().slice(0, 10)})`);
    const lockboxWinners: any[] = [];
    for (const f of finalists.filter(x => x.pass)) {
      const A = mkts.get(f.hyp.pair.a)!;
      const B = mkts.get(f.hyp.pair.b)!;
      let net = 0;
      let n = 0;
      let wins = 0;
      let busyUntil = 0;
      for (let i = 0; i < B.bars.length; i++) {
        const bar = B.bars[i];
        if (bar.t < lockboxFrom.getTime() || bar.t < busyUntil) continue;
        const aIdx = lastClosedA(A, bar.t);
        if (aIdx < 0 || !stateOf(A, aIdx).includes(f.hyp.state)) continue;
        const pnl = simTrade(B, bar, f.side, 20 * B.mult, 40 * B.mult, f.hyp.h * M15);
        if (pnl === null) continue;
        net += pnl;
        n += 1;
        if (pnl > 0) wins += 1;
        busyUntil = bar.t + M15 + f.hyp.h * M15;
      }
      const row = {
        rule: `${f.hyp.pair.a}[${f.hyp.state}]→${f.hyp.pair.b} h${f.hyp.h} ${f.side}`,
        train: f.train, val: f.val,
        lockboxNet: +net.toFixed(2), lockboxN: n, lockboxWins: wins,
      };
      lockboxWinners.push(row);
      console.log(`  ${net > 0 ? '🏆' : '💀'} ${row.rule}: сейф ${row.lockboxNet}$ (${n} сд, wins ${wins})`);
    }

    const outPath = path.join(process.cwd(), 'data', 'crossmarket-report.json');
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify({ from, lockboxFrom, to, nHyp, zBonf, survivors, finalists, lockboxWinners }, null, 1));
    console.log(`\nJSON: ${outPath}\nDONE`);
  })().catch(e => {
    console.error(e);
    process.exit(1);
  });
}
