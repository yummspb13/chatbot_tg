// Майнер-2: ИИ-генератор гипотез + фичефрейм + КУМУЛЯТИВНЫЙ леджер Бонферрони.
//
// Разделение труда (ответ на «подключим ИИ + память»): ИИ (автор этого файла)
// придумывает ПРИЗНАКИ и их сочетания — рыночную анатомию, которую считает
// осмысленной; статистика казнит. Деньги двигаются только после сейфа и
// виртуального форварда, как всегда.
//
// Ключевая честность — data/hypothesis-ledger.json: счётчик ВСЕХ гипотез,
// протестированных проектом за всю историю (стартует с ~4k, сожжённых
// майнером-1, слот-стади, гэпами и межрынком). Порог Бонферрони каждого нового
// батча считается от КУМУЛЯТИВНОЙ суммы — иначе батчи были бы способом обмануть
// поправку. Сейф (2026-05-01 → 07-30) один на всех, входы в него тоже считаем.
//
// Конвейер: фичефрейм (15 признаков на закрытом баре) → батч гипотез
// (синглы + курируемые пары + авторский список с обоснованиями) → этап 1
// t-тест форвард-хода с кумулятивным Бонферрони → этап 2 стратегизация
// (рыночный вход с реальным полуспредом, tp20/sl40 ×mult, тайм-выход = горизонт,
// train 60 / val 40) → этап 3 сейф.
//
// CLI: npx tsx src/backtest/miner2.ts --batch 1
//      [--markets eurusd,btcusd,...] [--from 2024-01-01] [--lockbox 2026-05-01] [--to 2026-07-30]

import { pathToFileURL } from 'node:url';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PIP } from '../broker/types';
import { Candle, loadM1WithSpread } from './data';
import { MARKETS, prepCandles } from './runner';

// ---------------------------------------------------------------- статистика

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

// ---------------------------------------------------------------- бары и фичефрейм

interface Bar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  sp: number;
  m1From: number;
}

function toBars(m1: Candle[], barMs: number): Bar[] {
  const out: Bar[] = [];
  let cur: Bar | null = null;
  let spSum = 0;
  let spN = 0;
  for (let i = 0; i < m1.length; i++) {
    const c = m1[i];
    const bucket = Math.floor(c.t / barMs) * barMs;
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

// Признаки — «анатомия рынка» глазами автора. Каждый признак — маленький словарь
// бакетов; гипотеза = требование конкретных бакетов у 1-2 признаков.
type Feat =
  | 'hour' | 'dow' | 'domSeg' | 'sign' | 'streak' | 'big' | 'body' | 'wick'
  | 'nr' | 'atrPct' | 'ema' | 'dPrev' | 'round' | 'spreadPct' | 'session';

interface Frame {
  bars: Bar[];
  f: Record<Feat, Int32Array>; // код бакета на бар (-1 = нет данных)
  fwd: Record<number, Float64Array>; // горизонт → форвард-ход в mult-пипсах (NaN = нет)
}

const ROUND_GRID_PIPS: Record<string, number> = {
  eurusd: 100, gbpjpy: 100, xauusd: 50, btcusd: 100, usa500idxusd: 50, lightcmdusd: 100,
};

function buildFrame(mkKey: string, m1: Candle[], barMs: number, mult: number, horizons: number[]): Frame {
  const bars = toBars(m1, barMs);
  const n = bars.length;
  const mk = (): Int32Array => new Int32Array(n).fill(-1);
  const f: Record<Feat, Int32Array> = {
    hour: mk(), dow: mk(), domSeg: mk(), sign: mk(), streak: mk(), big: mk(), body: mk(),
    wick: mk(), nr: mk(), atrPct: mk(), ema: mk(), dPrev: mk(), round: mk(), spreadPct: mk(), session: mk(),
  };

  const emaN = barMs === 3600_000 ? { mid: 8, slow: 32 } : { mid: 32, slow: 128 }; // ≈8ч/32ч и 8ч/32ч
  const aMid = 2 / (emaN.mid + 1);
  const aSlow = 2 / (emaN.slow + 1);
  let emaMid = NaN;
  let emaSlow = NaN;

  // дневные экстремумы прошлой UTC-сессии
  let dayKey = '';
  let dHi = NaN, dLo = NaN, dCl = NaN;       // текущая сессия (накапливается)
  let pHi = NaN, pLo = NaN, pCl = NaN;       // прошлая сессия (для признака)

  // перцентили ATR/спреда: границы пересчитываются раз в UTC-день по прошлым 30 дням
  const ranges: number[] = [];
  const spreads: number[] = [];
  let q = { atr25: NaN, atr75: NaN, sp33: NaN, sp66: NaN };
  let lastQDay = '';

  let streak = 0; // подряд одного знака (знак — по знаку последнего)
  const roundGrid = (ROUND_GRID_PIPS[mkKey] ?? 100) * PIP;

  for (let i = 0; i < n; i++) {
    const b = bars[i];
    const d = new Date(b.t);
    const ret = b.c - b.o;
    const range = b.h - b.l;

    // календарь
    f.hour[i] = d.getUTCHours();
    f.dow[i] = d.getUTCDay();
    const dom = d.getUTCDate();
    f.domSeg[i] = dom <= 10 ? 0 : dom <= 20 ? 1 : 2;
    const hr = d.getUTCHours();
    f.session[i] = hr < 7 ? 0 : hr < 13 ? 1 : hr < 21 ? 2 : 3; // asia/london/ny/roll

    // тело/фитили/знак/серии/big
    f.sign[i] = ret >= 0 ? 1 : 0;
    streak = i > 0 && f.sign[i] === f.sign[i - 1] ? streak + 1 : 1;
    f.streak[i] = Math.min(streak, 4) - 1 + (f.sign[i] ? 4 : 0); // d1..d4=0..3, u1..u4=4..7
    f.big[i] = Math.abs(ret) >= 3 * mult * PIP ? (ret >= 0 ? 1 : 2) : 0;
    if (range > 0) {
      const bodyFrac = Math.abs(ret) / range;
      f.body[i] = bodyFrac < 0.3 ? 0 : bodyFrac <= 0.7 ? 1 : 2;
      const upW = b.h - Math.max(b.o, b.c);
      const loW = Math.min(b.o, b.c) - b.l;
      f.wick[i] = upW > 2 * loW ? 0 : loW > 2 * upW ? 1 : 2;
    }

    // NR7 / WR7
    if (i >= 6) {
      let isNr = true;
      let isWr = true;
      for (let k = i - 6; k < i; k++) {
        const r2 = bars[k].h - bars[k].l;
        if (r2 <= range) isNr = false;
        if (r2 >= range) isWr = false;
      }
      f.nr[i] = isNr ? 0 : isWr ? 1 : 2;
    }

    // EMA-состояние (4 режима майнера-1)
    emaMid = Number.isFinite(emaMid) ? emaMid + aMid * (b.c - emaMid) : b.c;
    emaSlow = Number.isFinite(emaSlow) ? emaSlow + aSlow * (b.c - emaSlow) : b.c;
    if (i >= emaN.slow) {
      const up = emaMid > emaSlow;
      const above = b.c > emaSlow;
      f.ema[i] = up ? (above ? 3 : 2) : (above ? 1 : 0);
    }

    // границы перцентилей — раз в день, по прошлым 30 дням
    const day = d.toISOString().slice(0, 10);
    if (day !== lastQDay) {
      lastQDay = day;
      const tail = (xs: number[]) => xs.slice(-Math.min(xs.length, 2880));
      const rs = tail(ranges).slice().sort((x, y) => x - y);
      const ss = tail(spreads).slice().sort((x, y) => x - y);
      if (rs.length > 200) q = {
        atr25: rs[Math.floor(rs.length * 0.25)], atr75: rs[Math.floor(rs.length * 0.75)],
        sp33: ss[Math.floor(ss.length * 0.33)], sp66: ss[Math.floor(ss.length * 0.66)],
      };
      // смена сессии: текущие экстремумы уходят в «прошлые»
      if (dayKey && Number.isFinite(dHi)) {
        pHi = dHi; pLo = dLo; pCl = dCl;
      }
      dayKey = day;
      dHi = b.h; dLo = b.l;
    } else {
      dHi = Math.max(dHi, b.h);
      dLo = Math.min(dLo, b.l);
    }
    dCl = b.c;
    ranges.push(range);
    spreads.push(b.sp);
    if (Number.isFinite(q.atr25)) f.atrPct[i] = range < q.atr25 ? 0 : range > q.atr75 ? 2 : 1;
    if (Number.isFinite(q.sp33)) f.spreadPct[i] = b.sp < q.sp33 ? 0 : b.sp > q.sp66 ? 2 : 1;

    // позиция против экстремумов прошлой сессии
    if (Number.isFinite(pHi)) {
      const near = 5 * mult * PIP;
      f.dPrev[i] = b.c > pHi ? 0 : pHi - b.c <= near ? 1 : b.c < pLo ? 4 : b.c - pLo <= near ? 3 : 2;
    }

    // близость к круглому уровню
    const mod = ((b.c % roundGrid) + roundGrid) % roundGrid;
    const dist = Math.min(mod, roundGrid - mod);
    f.round[i] = dist <= 5 * mult * PIP ? 0 : 1;
  }

  const fwd: Record<number, Float64Array> = {};
  for (const h of horizons) {
    const arr = new Float64Array(n).fill(NaN);
    for (let i = 0; i + h < n; i++) {
      // сессионный разрыв длиннее 6ч — не форвард, а гэп через выходные
      if (bars[i + h].t - bars[i].t > h * barMs + 6 * 3600_000) continue;
      arr[i] = (bars[i + h].c - bars[i].c) / (mult * PIP);
    }
    fwd[h] = arr;
  }
  return { bars, f, fwd };
}

// ---------------------------------------------------------------- генератор гипотез

interface Hyp {
  market: string;
  tf: 15 | 60;
  h: number;
  conds: Partial<Record<Feat, number>>;
  author?: string; // непустое = авторская гипотеза с обоснованием
}

const FEAT_BUCKETS: Record<Feat, number> = {
  hour: 24, dow: 7, domSeg: 3, sign: 2, streak: 8, big: 3, body: 3, wick: 3,
  nr: 3, atrPct: 3, ema: 4, dPrev: 5, round: 2, spreadPct: 3, session: 4,
};

// Курируемые пары: не все C(15,2), а осмысленные сочетания «когда × что»
const PAIRS: Array<[Feat, Feat]> = [
  ['hour', 'sign'], ['hour', 'streak'], ['hour', 'ema'], ['hour', 'atrPct'],
  ['session', 'streak'], ['session', 'nr'], ['session', 'atrPct'], ['session', 'big'], ['session', 'wick'],
  ['dow', 'sign'], ['dow', 'ema'], ['dow', 'session'],
  ['ema', 'streak'], ['ema', 'big'], ['ema', 'dPrev'], ['ema', 'nr'],
  ['atrPct', 'streak'], ['atrPct', 'big'], ['spreadPct', 'big'], ['spreadPct', 'streak'],
  ['dPrev', 'sign'], ['dPrev', 'wick'], ['dPrev', 'session'],
  ['round', 'sign'], ['round', 'wick'], ['domSeg', 'session'], ['body', 'streak'], ['wick', 'streak'],
];

// Авторский список: конкретные сочетания с обоснованием — «интуиция под суд».
const AUTHOR: Array<{ conds: Partial<Record<Feat, number>>; why: string; markets?: string[] }> = [
  { conds: { session: 0, nr: 0 }, why: 'сжатие в Азии → пружина к Лондону' },
  { conds: { session: 1, nr: 1 }, why: 'разгон в Лондоне → инерция в НЙ' },
  { conds: { dPrev: 4, ema: 3 }, why: 'пробой вчерашнего лоя ПРОТИВ аптренда — ложный, ждём возврат' },
  { conds: { dPrev: 0, ema: 0 }, why: 'пробой вчерашнего хая против даунтренда — ложный' },
  { conds: { dPrev: 1, wick: 0 }, why: 'у вчерашнего хая с верхним фитилём — отбой' },
  { conds: { dPrev: 3, wick: 1 }, why: 'у вчерашнего лоя с нижним фитилём — отбой' },
  { conds: { hour: 21, spreadPct: 2 }, why: 'ролловер с раздутым спредом — фейд движения' },
  { conds: { dow: 5, session: 2, sign: 1 }, why: 'пятничный НЙ рост — фиксация перед выходными' },
  { conds: { domSeg: 2, session: 2 }, why: 'конец месяца, НЙ — потоки ребалансировки' },
  { conds: { round: 0, wick: 1 }, why: 'круглый уровень снизу с нижним фитилём — отбой вверх' },
  { conds: { round: 0, wick: 0 }, why: 'круглый уровень с верхним фитилём — отбой вниз' },
  { conds: { big: 2, spreadPct: 0 }, why: 'обвал на УЗКОМ спреде — настоящий поток, инерция' },
  { conds: { big: 1, spreadPct: 2 }, why: 'взлёт на раздутом спреде — воздух, фейд' },
  { conds: { atrPct: 0, streak: 3 }, why: '4 минуса в мёртвой воле — капитуляция без продавцов' },
  { conds: { atrPct: 2, streak: 7 }, why: '4 плюса в буре — жадность на исходе' },
  { conds: { body: 0, big: 0, nr: 0 }, why: 'дожи в NR7 — решение зреет' },
  { conds: { wick: 1, streak: 1 }, why: 'два минуса подряд с нижними тенями — покупатель уже в стакане' },
  { conds: { ema: 2, big: 1 }, why: 'аптренд, цена под slow, big-up — возврат в тренд' },
  { conds: { ema: 1, big: 2 }, why: 'даунтренд, цена над slow, big-down — возврат в тренд (шорт)' },
  { conds: { session: 3, sign: 0 }, why: 'ролловерное сползание — эхо часа-20 на всех рынках' },
];

function* genHypotheses(markets: string[], tfs: Array<15 | 60>, horizons: number[]): Generator<Hyp> {
  for (const market of markets) {
    for (const tf of tfs) {
      for (const h of horizons) {
        // синглы
        for (const feat of Object.keys(FEAT_BUCKETS) as Feat[]) {
          for (let bkt = 0; bkt < FEAT_BUCKETS[feat]; bkt++) {
            yield { market, tf, h, conds: { [feat]: bkt } };
          }
        }
        // курируемые пары
        for (const [f1, f2] of PAIRS) {
          for (let b1 = 0; b1 < FEAT_BUCKETS[f1]; b1++) {
            for (let b2 = 0; b2 < FEAT_BUCKETS[f2]; b2++) {
              yield { market, tf, h, conds: { [f1]: b1, [f2]: b2 } };
            }
          }
        }
        // авторские
        for (const a of AUTHOR) {
          if (a.markets && !a.markets.includes(market)) continue;
          yield { market, tf, h, conds: a.conds, author: a.why };
        }
      }
    }
  }
}

// ---------------------------------------------------------------- леджер

interface Ledger {
  totalTested: number;
  lockboxEntrants: number;
  batches: Array<{ id: string; when: string; n: number; stage1: number; stage2: number; lockboxWins: number }>;
}

const LEDGER_PATH = path.join(process.cwd(), 'data', 'hypothesis-ledger.json');

function loadLedger(): Ledger {
  if (existsSync(LEDGER_PATH)) return JSON.parse(readFileSync(LEDGER_PATH, 'utf8')) as Ledger;
  // стартуем с уже сожжённого прошлыми исследованиями (майнер-1 ×2, слоты, гэпы, межрынок)
  return {
    totalTested: 1244 + 2364 + 256 + 18 + 72,
    lockboxEntrants: 10 + 6,
    batches: [{ id: 'история до майнера-2', when: '2026-08-01..03', n: 3954, stage1: 61, stage2: 16, lockboxWins: 5 }],
  };
}

// ---------------------------------------------------------------- симуляция правила (M1)

function simRule(m1: Candle[], bar: Bar, side: 'BUY' | 'SELL', tpPips: number, slPips: number, horizonMs: number): number | null {
  const i0 = bar.m1From;
  const c0 = m1[i0];
  if (!c0) return null;
  const half0 = (c0.sp ?? PIP) / 2;
  const entry = side === 'BUY' ? c0.c + half0 : c0.c - half0;
  const tp = side === 'BUY' ? entry + tpPips * PIP : entry - tpPips * PIP;
  const sl = side === 'BUY' ? entry - slPips * PIP : entry + slPips * PIP;
  const deadline = bar.t + horizonMs;
  for (let i = i0 + 1; i < m1.length; i++) {
    const c = m1[i];
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
    if (c.t - bar.t > 48 * 3600_000) break;
  }
  return null;
}

// ---------------------------------------------------------------- главный прогон

function parseArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  (async () => {
    const batchId = parseArg('batch') ?? '1';
    const marketKeys = (parseArg('markets') ?? 'eurusd,btcusd,xauusd,gbpjpy,usa500idxusd,lightcmdusd').split(',');
    const from = new Date(parseArg('from') ?? '2024-01-01');
    const lockboxFrom = new Date(parseArg('lockbox') ?? '2026-05-01');
    const to = new Date(parseArg('to') ?? '2026-07-30');
    const tfs: Array<15 | 60> = [15, 60];
    const horizons = [1, 4];

    // фреймы
    const frames = new Map<string, Record<number, Frame>>();
    const m1byMarket = new Map<string, Candle[]>();
    for (const mk of marketKeys) {
      const spec = MARKETS[mk];
      const mult = spec.pipsMult ?? 1;
      const m1 = prepCandles(await loadM1WithSpread(spec.instrument, from, to), spec);
      m1byMarket.set(mk, m1);
      const rec: Record<number, Frame> = {};
      for (const tf of tfs) rec[tf] = buildFrame(mk, m1, tf * 60_000, mult, horizons);
      frames.set(mk, rec);
      console.log(`${mk}: M15 ${rec[15].bars.length} баров, H60 ${rec[60].bars.length}`);
    }

    // батч
    const hyps = [...genHypotheses(marketKeys, tfs, horizons)];
    const ledger = loadLedger();
    const cumTotal = ledger.totalTested + hyps.length;
    const zBonf = normalQuantile(1 - (0.05 / cumTotal) / 2);
    console.log(`\nБатч №${batchId}: гипотез ${hyps.length} (авторских ${hyps.filter(x => x.author).length})`);
    console.log(`Леджер: уже сожжено ${ledger.totalTested} → кумулятивно ${cumTotal} → порог |t|≥${zBonf.toFixed(2)}\n`);

    // этап 1
    interface S1 {
      hyp: Hyp;
      mean: number;
      t: number;
      n: number;
    }
    const lockMs = lockboxFrom.getTime();

    // ДЕТРЕНД (урок батча №1: 9 «находок» оказались переодетой ставкой «золото
    // растёт»): гипотеза судится по ПРЕВЫШЕНИЮ над безусловным дрейфом своего
    // рынка/ТФ/горизонта, а не по сырому ходу. Дрейф-костюмы больше не проходят.
    const uncond = new Map<string, number>();
    for (const [mk, rec] of frames) {
      for (const tf of tfs) {
        for (const h of horizons) {
          const fwd = rec[tf].fwd[h];
          const bars = rec[tf].bars;
          let s = 0;
          let n = 0;
          for (let i = 0; i < bars.length; i++) {
            if (bars[i].t >= lockMs) break;
            const x = fwd[i];
            if (!Number.isNaN(x)) {
              s += x;
              n += 1;
            }
          }
          uncond.set(`${mk}|${tf}|${h}`, n ? s / n : 0);
        }
      }
    }

    const survivors: S1[] = [];
    let evaluated = 0;
    for (const hyp of hyps) {
      const frame = frames.get(hyp.market)![hyp.tf];
      const fwd = frame.fwd[hyp.h];
      const drift = uncond.get(`${hyp.market}|${hyp.tf}|${hyp.h}`) ?? 0;
      const conds = Object.entries(hyp.conds) as Array<[Feat, number]>;
      let sum = 0;
      let sumSq = 0;
      let n = 0;
      const bars = frame.bars;
      for (let i = 0; i < bars.length; i++) {
        if (bars[i].t >= lockMs) break;
        let ok = true;
        for (const [feat, bkt] of conds) {
          if (frame.f[feat][i] !== bkt) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        const x = fwd[i];
        if (Number.isNaN(x)) continue;
        sum += x;
        sumSq += x * x;
        n += 1;
      }
      evaluated += 1;
      if (n < 300) continue;
      const mean = sum / n;
      const sd = Math.sqrt(Math.max(0, (sumSq - n * mean * mean) / (n - 1)));
      const excess = mean - drift; // сдвиг константой sd не меняет
      const t = sd > 0 ? excess / (sd / Math.sqrt(n)) : 0;
      if (Math.abs(t) >= zBonf) survivors.push({ hyp, mean: excess, t, n });
    }
    survivors.sort((x, y) => Math.abs(y.t) - Math.abs(x.t));
    console.log(`Этап 1: оценено ${evaluated}, выжило ${survivors.length}`);
    const descr = (s: S1) =>
      `${s.hyp.market} M${s.hyp.tf} h${s.hyp.h} {${Object.entries(s.hyp.conds).map(([k, v]) => `${k}=${v}`).join(',')}}${s.hyp.author ? ` [${s.hyp.author}]` : ''}`;
    for (const s of survivors.slice(0, 30)) {
      console.log(`  ${descr(s)}: mean ${s.mean >= 0 ? '+' : ''}${s.mean.toFixed(2)}п, t=${s.t.toFixed(2)}, n=${s.n}`);
    }

    // этап 2: топ-30 по |t| → стратегизация
    console.log('\nЭтап 2: стратегизация (train 60 / val 40, вход по рынку, tp20/sl40 ×mult, выход = горизонт)');
    interface S2 {
      s1: S1;
      side: 'BUY' | 'SELL';
      train: number;
      val: number;
      nTr: number;
      nVal: number;
      pass: boolean;
    }
    const finalists: S2[] = [];
    for (const s1 of survivors.slice(0, 30)) {
      const frame = frames.get(s1.hyp.market)![s1.hyp.tf];
      const m1 = m1byMarket.get(s1.hyp.market)!;
      const mult = MARKETS[s1.hyp.market].pipsMult ?? 1;
      const side: 'BUY' | 'SELL' = s1.mean > 0 ? 'BUY' : 'SELL';
      const conds = Object.entries(s1.hyp.conds) as Array<[Feat, number]>;
      const horizonMs = s1.hyp.h * s1.hyp.tf * 60_000;
      const pnls: number[] = [];
      let busyUntil = 0;
      for (let i = 0; i < frame.bars.length; i++) {
        const bar = frame.bars[i];
        if (bar.t >= lockMs) break;
        if (bar.t < busyUntil) continue;
        let ok = true;
        for (const [feat, bkt] of conds) {
          if (frame.f[feat][i] !== bkt) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        const next = frame.bars[i + 1];
        if (!next || next.t - bar.t > s1.hyp.tf * 60_000 + 3600_000) continue;
        const pnl = simRule(m1, next, side, 20 * mult, 40 * mult, horizonMs);
        if (pnl === null) continue;
        pnls.push(pnl);
        busyUntil = next.t + horizonMs;
      }
      const cut = Math.floor(pnls.length * 0.6);
      const train = pnls.slice(0, cut).reduce((s, x) => s + x, 0);
      const val = pnls.slice(cut).reduce((s, x) => s + x, 0);
      const res: S2 = {
        s1, side,
        train: +train.toFixed(2), val: +val.toFixed(2),
        nTr: cut, nVal: pnls.length - cut,
        pass: train > 0 && val > 0 && cut >= 30,
      };
      finalists.push(res);
      console.log(`  ${res.pass ? '✅' : '❌'} ${descr(s1)} (${side}): train ${res.train}$ (${res.nTr}) / val ${res.val}$ (${res.nVal})`);
    }

    // этап 3: сейф
    const passers = finalists.filter(x => x.pass);
    console.log(`\nЭтап 3: сейф (${lockboxFrom.toISOString().slice(0, 10)} → ${to.toISOString().slice(0, 10)}) — входит ${passers.length}`);
    const lockboxRows: any[] = [];
    for (const f2 of passers) {
      const frame = frames.get(f2.s1.hyp.market)![f2.s1.hyp.tf];
      const m1 = m1byMarket.get(f2.s1.hyp.market)!;
      const mult = MARKETS[f2.s1.hyp.market].pipsMult ?? 1;
      const conds = Object.entries(f2.s1.hyp.conds) as Array<[Feat, number]>;
      const horizonMs = f2.s1.hyp.h * f2.s1.hyp.tf * 60_000;
      let net = 0;
      let n = 0;
      let wins = 0;
      let busyUntil = 0;
      for (let i = 0; i < frame.bars.length; i++) {
        const bar = frame.bars[i];
        if (bar.t < lockMs || bar.t < busyUntil) continue;
        let ok = true;
        for (const [feat, bkt] of conds) {
          if (frame.f[feat][i] !== bkt) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        const next = frame.bars[i + 1];
        if (!next) continue;
        const pnl = simRule(m1, next, f2.side, 20 * mult, 40 * mult, horizonMs);
        if (pnl === null) continue;
        net += pnl;
        n += 1;
        if (pnl > 0) wins += 1;
        busyUntil = next.t + horizonMs;
      }
      const row = { rule: descr(f2.s1), side: f2.side, train: f2.train, val: f2.val, lockboxNet: +net.toFixed(2), lockboxN: n, lockboxWins: wins };
      lockboxRows.push(row);
      console.log(`  ${net > 0 ? '🏆' : '💀'} ${row.rule} (${row.side}): сейф ${row.lockboxNet}$ (${n} сд, wins ${wins})`);
    }

    // леджер и отчёт
    ledger.totalTested = cumTotal;
    ledger.lockboxEntrants += passers.length;
    ledger.batches.push({
      id: `батч-${batchId}`, when: new Date().toISOString().slice(0, 10), n: hyps.length,
      stage1: survivors.length, stage2: passers.length,
      lockboxWins: lockboxRows.filter(r => r.lockboxNet > 0).length,
    });
    writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 1));

    const outPath = path.join(process.cwd(), 'data', `miner2-batch${batchId}.json`);
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify({
      batchId, from, lockboxFrom, to, nHyps: hyps.length, cumTotal, zBonf,
      stage1: survivors.slice(0, 100).map(s => ({ rule: descr(s), mean: +s.mean.toFixed(3), t: +s.t.toFixed(2), n: s.n })),
      stage2: finalists.map(f => ({ rule: descr(f.s1), side: f.side, train: f.train, val: f.val, pass: f.pass })),
      lockbox: lockboxRows,
    }, null, 1));
    console.log(`\nЛеджер: всего сожжено ${ledger.totalTested} гипотез, входов в сейф ${ledger.lockboxEntrants}`);
    console.log(`JSON: ${outPath}\nDONE`);
  })().catch(e => {
    console.error(e);
    process.exit(1);
  });
}
