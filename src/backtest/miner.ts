// Майнер закономерностей: систематический перебор условных зависимостей
// с ЧЕСТНОЙ поправкой на множественность — ответ на «прогони 1000 вариаций».
//
// Три этапа:
//  1. СКРИНИНГ: ~1400 гипотез вида «состояние рынка → средний ход следующих
//     баров» (знаки последних свечей, час, день недели, положение к EMA 2ч/8ч,
//     зона POC прошлой сессии, режим волатильности; M15 и H1; горизонты 1 и 4
//     бара). Каждая гипотеза — таблица, не бэктест. Порог значимости —
//     Бонферрони: α = 0.05 / число_гипотез (|t| ≳ 4).
//  2. СТРАТЕГИЗАЦИЯ: топ выживших (≤10, по одному на семейство) превращаются
//     в правила «предикат истинен → вход по направлению знака» и гоняются
//     бэктестом (рыночный вход с полным спредом — пессимизм) на train 60% /
//     validation 40% майнингового окна. Проход = плюс на обоих.
//  3. СЕЙФ: последние ~3 месяца данных не участвуют ни в скрининге, ни в
//     подборе — победители этапа 2 прогоняются по ним ОДИН раз.
//
// CLI: npm run miner -- --pairs eurusd,btcusd --from 2024-01-01 \
//        --lockbox 2026-05-01 --to 2026-07-30
//
// Ожидания откалиброваны заранее: из ~1400 гипотез после поправок обычно
// выживают единицы, и часть окажется уже известным (антиперсистентность FX,
// трендовость BTC). Ноль выживших — тоже валидный результат.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PIP } from '../broker/types';
import { Candle, loadM1 } from './data';
import { MARKETS, MarketSpec, prepCandles } from './runner';

// ---------------------------------------------------------------- утилиты

function aggregate(m1: Candle[], minutes: number): Candle[] {
  const out: Candle[] = [];
  let cur: Candle | null = null;
  for (const c of m1) {
    const bucket = Math.floor(c.t / (minutes * 60_000));
    if (!cur || Math.floor(cur.t / (minutes * 60_000)) !== bucket) {
      if (cur) out.push(cur);
      cur = { t: bucket * minutes * 60_000, o: c.o, h: c.h, l: c.l, c: c.c };
    } else {
      cur.h = Math.max(cur.h, c.h);
      cur.l = Math.min(cur.l, c.l);
      cur.c = c.c;
    }
  }
  if (cur) out.push(cur);
  return out;
}

interface Acc {
  n: number;
  sum: number;
  sumsq: number;
}

function tStat(a: Acc): number {
  if (a.n < 30) return 0;
  const mean = a.sum / a.n;
  const varr = Math.max(1e-12, a.sumsq / a.n - mean * mean);
  return mean / Math.sqrt(varr / a.n);
}

/** Состояние рынка на минутном уровне (EMA-режим, POC-зона), семплируется на закрытиях TF-баров. */
interface MinuteState {
  emaState: number; // 0..3: (mid>slow?2:0)+(price>slow?1:0)
  pocZone: number;  // 0 около POC, 1 выше, 2 ниже, 3 нет уровней
}

function buildMinuteState(m1: Candle[], pipsMult: number): MinuteState[] {
  const out: MinuteState[] = new Array(m1.length);
  const aMid = 2 / (120 + 1);  // EMA 2ч по минутам
  const aSlow = 2 / (480 + 1); // EMA 8ч
  let emaMid = NaN;
  let emaSlow = NaN;
  const tol = 5 * pipsMult * PIP;
  const binSize = 2 * pipsMult * PIP;
  let dayKey = '';
  let bins = new Map<number, number>();
  let poc: number | null = null;
  for (let i = 0; i < m1.length; i++) {
    const c = m1[i];
    emaMid = Number.isFinite(emaMid) ? emaMid + aMid * (c.c - emaMid) : c.c;
    emaSlow = Number.isFinite(emaSlow) ? emaSlow + aSlow * (c.c - emaSlow) : c.c;
    const day = new Date(c.t).toISOString().slice(0, 10);
    if (day !== dayKey) {
      if (dayKey && bins.size >= 30) {
        let best = -1;
        let bestN = -1;
        for (const [b, n] of bins) if (n > bestN) { bestN = n; best = b; }
        poc = best * binSize;
      } else if (dayKey) {
        poc = null;
      }
      dayKey = day;
      bins = new Map();
    }
    const bin = Math.round(c.c / binSize);
    bins.set(bin, (bins.get(bin) ?? 0) + 1);
    const emaState = (emaMid > emaSlow ? 2 : 0) + (c.c > emaSlow ? 1 : 0);
    const pocZone = poc === null ? 3 : Math.abs(c.c - poc) <= tol ? 0 : c.c > poc ? 1 : 2;
    out[i] = { emaState, pocZone };
  }
  return out;
}

// ---------------------------------------------------------------- этап 1

export interface Hypothesis {
  pair: string;
  tf: number;
  horizon: number;
  family: string;
  key: string;
  n: number;
  meanPips: number;
  t: number;
}

interface TfBar {
  t: number;
  c: number;
  sign: '+' | '-';
  hour: number;
  dow: number;
  emaState: number;
  pocZone: number;
  hiVol: boolean;
}

function buildTfBars(m1: Candle[], state: MinuteState[], tfMin: number): TfBar[] {
  // индекс последней минутки каждого TF-бара
  const bars = aggregate(m1, tfMin);
  const out: TfBar[] = [];
  let mIdx = 0;
  const ranges: number[] = [];
  for (const b of bars) {
    const end = b.t + tfMin * 60_000;
    while (mIdx + 1 < m1.length && m1[mIdx + 1].t < end) mIdx++;
    const st = state[mIdx];
    const range = b.h - b.l;
    ranges.push(range);
    const recent = ranges.slice(-48).sort((x, y) => x - y);
    const med = recent[Math.floor(recent.length / 2)] || 0;
    const d = new Date(b.t);
    out.push({
      t: b.t,
      c: b.c,
      sign: b.c >= b.o ? '+' : '-',
      hour: d.getUTCHours(),
      dow: d.getUTCDay(),
      emaState: st.emaState,
      pocZone: st.pocZone,
      hiVol: range > med,
    });
  }
  return out;
}

function screen(pair: string, bars: TfBar[], tfMin: number, horizons: number[]): Hypothesis[] {
  const accs = new Map<string, Acc>();
  const add = (key: string, ret: number) => {
    const a = accs.get(key) ?? { n: 0, sum: 0, sumsq: 0 };
    a.n += 1;
    a.sum += ret;
    a.sumsq += ret * ret;
    accs.set(key, a);
  };
  for (let i = 3; i < bars.length - Math.max(...horizons); i++) {
    const b = bars[i];
    for (const h of horizons) {
      const ret = (bars[i + h].c - b.c) / PIP;
      const hz = `h${h}`;
      const s1 = b.sign;
      const s2 = bars[i - 1].sign + s1;
      const s3 = bars[i - 2].sign + s2;
      add(`${hz}|signs1|${s1}`, ret);
      add(`${hz}|signs2|${s2}`, ret);
      add(`${hz}|signs3|${s3}`, ret);
      add(`${hz}|hour|${b.hour}`, ret);
      add(`${hz}|dow|${b.dow}`, ret);
      add(`${hz}|ema|${b.emaState}`, ret);
      add(`${hz}|poc|${b.pocZone}`, ret);
      add(`${hz}|vol|${b.hiVol ? 'hi' : 'lo'}`, ret);
      add(`${hz}|signs2ema|${s2}~${b.emaState}`, ret);
      add(`${hz}|houema|${b.hour}~${b.emaState}`, ret);
      add(`${hz}|pocema|${b.pocZone}~${b.emaState}`, ret);
    }
  }
  const out: Hypothesis[] = [];
  for (const [key, a] of accs) {
    if (a.n < 100) continue;
    const [hz, family, k] = key.split('|');
    out.push({
      pair, tf: tfMin, horizon: Number(hz.slice(1)), family, key: k,
      n: a.n, meanPips: +(a.sum / a.n).toFixed(4), t: +tStat(a).toFixed(2),
    });
  }
  return out;
}

// ---------------------------------------------------------------- этап 2

interface RuleResult {
  net: number;
  trades: number;
  wins: number;
}

/** Пессимистичный бэктест правила: рыночный вход с ПОЛНЫМ спредом,
 *  TP/SL по минуткам, тайм-стоп через horizon TF-баров. */
function runRule(
  m1: Candle[], state: MinuteState[], hypo: Hypothesis, market: MarketSpec,
  tpPips: number, slPips: number,
): RuleResult {
  const bars = buildTfBars(m1, state, hypo.tf);
  const dir = hypo.meanPips > 0 ? 1 : -1;
  const spread = market.spreadBase * PIP;
  const units = 1000;
  // индекс минуток по времени для исполнения
  let mi = 0;
  let net = 0;
  let trades = 0;
  let wins = 0;
  let openUntil = 0; // время тайм-стопа открытой позиции; 0 = флэт
  let entry = 0;
  const matches = (b: TfBar, i: number): boolean => {
    const map: Record<string, string> = {
      signs1: b.sign,
      signs2: i >= 1 ? bars[i - 1].sign + b.sign : '',
      signs3: i >= 2 ? bars[i - 2].sign + bars[i - 1].sign + b.sign : '',
      hour: String(b.hour),
      dow: String(b.dow),
      ema: String(b.emaState),
      poc: String(b.pocZone),
      vol: b.hiVol ? 'hi' : 'lo',
      signs2ema: i >= 1 ? `${bars[i - 1].sign + b.sign}~${b.emaState}` : '',
      houema: `${b.hour}~${b.emaState}`,
      pocema: `${b.pocZone}~${b.emaState}`,
    };
    return map[hypo.family] === hypo.key;
  };
  for (let i = 3; i < bars.length; i++) {
    const b = bars[i];
    const barEnd = b.t + hypo.tf * 60_000;
    // прокрутить минутки до конца бара, обслуживая открытую позицию
    while (mi < m1.length && m1[mi].t < barEnd) {
      const c = m1[mi];
      if (openUntil > 0) {
        const half = spread / 2;
        let exit: number | null = null;
        if (dir > 0) {
          if (c.l - half <= entry - slPips * PIP) exit = entry - slPips * PIP;
          else if (c.h - half >= entry + tpPips * PIP) exit = entry + tpPips * PIP;
        } else {
          if (c.h + half >= entry + slPips * PIP) exit = entry + slPips * PIP;
          else if (c.l + half <= entry - tpPips * PIP) exit = entry - tpPips * PIP;
        }
        if (exit === null && c.t >= openUntil) exit = dir > 0 ? c.c - half : c.c + half;
        if (exit !== null) {
          const pnl = dir * (exit - entry) * units;
          net += pnl;
          trades += 1;
          if (pnl > 0) wins += 1;
          openUntil = 0;
        }
      }
      mi++;
    }
    if (openUntil === 0 && matches(b, i)) {
      entry = dir > 0 ? b.c + spread / 2 : b.c - spread / 2; // рыночный вход: платим спред
      openUntil = b.t + hypo.horizon * hypo.tf * 60_000;
    }
  }
  return { net: +net.toFixed(2), trades, wins };
}

// ---------------------------------------------------------------- CLI

function parseArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  (async () => {
    const pairs = (parseArg('pairs') ?? 'eurusd,btcusd').split(',');
    const from = new Date(parseArg('from') ?? '2024-01-01');
    const lockbox = new Date(parseArg('lockbox') ?? '2026-05-01');
    const to = new Date(parseArg('to') ?? '2026-07-30');

    const report: Record<string, unknown> = { from, lockbox, to };
    let totalHypos = 0;
    const allSurvivors: Hypothesis[] = [];
    const perPair: Record<string, { mining: Candle[]; lock: Candle[]; state: MinuteState[]; stateLock: MinuteState[] }> = {};

    for (const pair of pairs) {
      const market = MARKETS[pair];
      const all = prepCandles(await loadM1(pair, from, to), market);
      const mining = all.filter(c => c.t < lockbox.getTime());
      const lock = all.filter(c => c.t >= lockbox.getTime());
      const pm = market.pipsMult ?? 1;
      perPair[pair] = {
        mining, lock,
        state: buildMinuteState(mining, pm),
        stateLock: buildMinuteState(lock, pm),
      };
      console.log(`${pair}: майнинг ${mining.length} минуток, сейф ${lock.length}`);

      const hypos: Hypothesis[] = [];
      for (const tf of [15, 60]) {
        const bars = buildTfBars(mining, perPair[pair].state, tf);
        hypos.push(...screen(pair, bars, tf, [1, 4]));
      }
      totalHypos += hypos.length;
      allSurvivors.push(...hypos);
    }

    // Бонферрони по ПОЛНОМУ числу гипотез
    const alpha = 0.05 / totalHypos;
    // двусторонний порог t для нормального приближения
    const tCrit = Math.sqrt(2) * inverseErfc(alpha); // |t| порог
    const survivors = allSurvivors.filter(h => Math.abs(h.t) >= tCrit)
      .sort((a, b) => Math.abs(b.t) - Math.abs(a.t));
    console.log(`\nЭтап 1: гипотез ${totalHypos}, порог Бонферрони |t| ≥ ${tCrit.toFixed(2)}, выжило ${survivors.length}`);
    for (const h of survivors.slice(0, 25)) {
      console.log(`  ${h.pair} M${h.tf} h${h.horizon} ${h.family}=${h.key}: mean ${h.meanPips >= 0 ? '+' : ''}${h.meanPips}p, t=${h.t}, n=${h.n}`);
    }
    report.stage1 = { totalHypos, tCrit: +tCrit.toFixed(2), survivors: survivors.slice(0, 50) };

    // Этап 2: по одному лучшему на (pair, family) — максимум 10
    const picked: Hypothesis[] = [];
    const seenFam = new Set<string>();
    for (const h of survivors) {
      const famKey = `${h.pair}|${h.family}`;
      if (seenFam.has(famKey)) continue;
      seenFam.add(famKey);
      picked.push(h);
      if (picked.length >= 10) break;
    }
    console.log(`\nЭтап 2: стратегизация ${picked.length} правил (train 60% / validation 40% майнингового окна)`);
    const stage2: unknown[] = [];
    const finalists: { h: Hypothesis; tp: number; sl: number }[] = [];
    for (const h of picked) {
      const market = MARKETS[h.pair];
      const pm = market.pipsMult ?? 1;
      const { mining, state } = perPair[h.pair];
      const cut = Math.floor(mining.length * 0.6);
      const train = mining.slice(0, cut);
      const val = mining.slice(cut);
      const stTrain = state.slice(0, cut);
      const stVal = state.slice(cut);
      let best: { tp: number; sl: number; tr: RuleResult; va: RuleResult } | null = null;
      for (const tp of [10 * pm, 20 * pm]) {
        for (const sl of [20 * pm]) {
          const tr = runRule(train, stTrain, h, market, tp, sl);
          const va = runRule(val, stVal, h, market, tp, sl);
          if (tr.trades >= 20 && va.trades >= 20 && tr.net > 0 && va.net > 0) {
            if (!best || va.net > best.va.net) best = { tp, sl, tr, va };
          }
        }
      }
      const label = `${h.pair} M${h.tf} h${h.horizon} ${h.family}=${h.key} (${h.meanPips > 0 ? 'LONG' : 'SHORT'})`;
      if (best) {
        console.log(`  ✅ ${label}: train ${best.tr.net}$ (${best.tr.trades} сд) / val ${best.va.net}$ (${best.va.trades} сд) [tp=${best.tp} sl=${best.sl}]`);
        finalists.push({ h, tp: best.tp, sl: best.sl });
        stage2.push({ rule: label, ...best });
      } else {
        console.log(`  ❌ ${label}: не прошло train/validation`);
        stage2.push({ rule: label, passed: false });
      }
    }
    report.stage2 = stage2;

    // Этап 3: сейф — один прогон
    console.log(`\nЭтап 3: сейф (${lockbox.toISOString().slice(0, 10)} → ${to.toISOString().slice(0, 10)}) — ${finalists.length} финалистов`);
    const stage3: unknown[] = [];
    for (const f of finalists) {
      const market = MARKETS[f.h.pair];
      const { lock, stateLock } = perPair[f.h.pair];
      const r = runRule(lock, stateLock, f.h, market, f.tp, f.sl);
      const verdict = r.net > 0 && r.trades >= 10;
      console.log(`  ${verdict ? '🏆' : '💀'} ${f.h.pair} ${f.h.family}=${f.h.key}: сейф ${r.net}$ (${r.trades} сд, wins ${r.wins})`);
      stage3.push({ pair: f.h.pair, family: f.h.family, key: f.h.key, tf: f.h.tf, horizon: f.h.horizon, tp: f.tp, sl: f.sl, ...r, verdict });
    }
    report.stage3 = stage3;

    mkdirSync(path.join(process.cwd(), 'data'), { recursive: true });
    writeFileSync(path.join(process.cwd(), 'data', 'miner-report.json'), JSON.stringify(report, null, 2));
    console.log('\nОтчёт: data/miner-report.json\nDONE');
  })().catch(e => {
    console.error(e);
    process.exit(1);
  });
}

/** Обратная дополнительная функция ошибок (аппроксимация Джайлса) для порога t. */
function inverseErfc(p: number): number {
  const x = Math.min(Math.max(p, 1e-300), 2 - 1e-16);
  const t = Math.sqrt(-2 * Math.log(x / 2));
  // приближение с уточнением Ньютоном
  let r = t - (2.30753 + 0.27061 * t) / (1 + 0.99229 * t + 0.04481 * t * t);
  for (let i = 0; i < 3; i++) {
    const err = erfc(r) - x;
    r += err / ((2 / Math.sqrt(Math.PI)) * Math.exp(-r * r));
  }
  return r;
}

function erfc(z: number): number {
  const t = 1 / (1 + 0.5 * Math.abs(z));
  const ans = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418
    + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587
    + t * (-0.82215223 + t * 0.17087277)))))))));
  return z >= 0 ? ans : 2 - ans;
}
