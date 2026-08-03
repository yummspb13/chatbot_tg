// Слот-стади новостей: что делает цена ПОСЛЕ фиксированных макро-слотов.
//
// Идея «догнать новость за 20-30 сек» похоронена разбором (покупка вершины с
// разорванным спредом). Здесь тестируются противоположные, взрослые гипотезы:
//   drift — рынок доваривает новость 30-120 минут (входим ПО направлению шипа
//           через N минут после слота);
//   fade  — шип перелетает (входим ПРОТИВ направления шипа — наш подтверждённый
//           анти-персистенс, но с якорем на событии).
//
// ЧЕСТНАЯ РАМКА: без архива прогнозов это слот-стади, НЕ сюрприз-стади — мы
// тестируем безусловную микроструктуру «после 12:30 первой пятницы», не «NFP
// вышел лучше консенсуса». Слоты детерминированы:
//   NFP  — первая пятница месяца, 12:30 UTC при летнем времени США, иначе 13:30;
//   FOMC — решения ФРС (хардкод дат 2024-2026), 14:00 ET = 18:00/19:00 UTC;
//   EIA  — запасы нефти, среда 14:30/15:30 UTC (праздничные сдвиги на четверг —
//          принятый шум, ~4% событий).
// usd-macro — пул NFP+FOMC (выборки поодиночке малы, честно помечаем).
//
// Метод: часть A — измерение пути и РЕАЛЬНОГО спреда (Candle.sp) вокруг слота;
// часть B — грид правил с walk-forward 70/30 по событиям и Бонферрони по всем
// ячейкам (та же дисциплина, что в майнере: массовый перебор без поправки —
// станок по производству ложных открытий).
//
// CLI: npx tsx src/backtest/news-slots.ts [--from 2024-01-01] [--to 2026-07-30]

import { pathToFileURL } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PIP } from '../broker/types';
import { Candle, loadM1WithSpread } from './data';
import { MARKETS, prepCandles } from './runner';

// ---------------------------------------------------------------- слоты

/** Летнее время США: со 2-го воскресенья марта до 1-го воскресенья ноября. */
function usDst(d: Date): boolean {
  const y = d.getUTCFullYear();
  const nthSunday = (month: number, n: number): number => {
    const first = new Date(Date.UTC(y, month, 1)).getUTCDay();
    return 1 + ((7 - first) % 7) + (n - 1) * 7;
  };
  const start = Date.UTC(y, 2, nthSunday(2, 2), 7); // 2:00 локальных ≈ 07:00 UTC
  const end = Date.UTC(y, 10, nthSunday(10, 1), 7);
  return d.getTime() >= start && d.getTime() < end;
}

/** Дата решения FOMC (день публикации заявления, 14:00 ET). */
const FOMC_DATES = [
  '2024-01-31', '2024-03-20', '2024-05-01', '2024-06-12', '2024-07-31', '2024-09-18', '2024-11-07', '2024-12-18',
  '2025-01-29', '2025-03-19', '2025-05-07', '2025-06-18', '2025-07-30', '2025-09-17', '2025-10-29', '2025-12-10',
  '2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17', '2026-07-29',
];

type SlotClass = 'nfp' | 'fomc' | 'eia';

interface SlotEvent {
  cls: SlotClass;
  t: number; // UTC ms момента публикации
}

function buildEvents(from: Date, to: Date): SlotEvent[] {
  const out: SlotEvent[] = [];
  // NFP: первая пятница месяца
  const cur = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  while (cur.getTime() < to.getTime()) {
    const dow = cur.getUTCDay();
    const firstFriday = 1 + ((5 - dow + 7) % 7);
    const d = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth(), firstFriday, 12, 30));
    if (!usDst(d)) d.setUTCHours(13);
    if (d.getTime() >= from.getTime() && d.getTime() < to.getTime()) out.push({ cls: 'nfp', t: d.getTime() });
    cur.setUTCMonth(cur.getUTCMonth() + 1);
  }
  // FOMC: 14:00 ET = 18:00 UTC летом, 19:00 зимой
  for (const ds of FOMC_DATES) {
    const d = new Date(`${ds}T18:00:00Z`);
    if (!usDst(d)) d.setUTCHours(19);
    if (d.getTime() >= from.getTime() && d.getTime() < to.getTime()) out.push({ cls: 'fomc', t: d.getTime() });
  }
  // EIA: каждая среда 10:30 ET = 14:30/15:30 UTC
  const w = new Date(from.getTime());
  while (w.getTime() < to.getTime()) {
    if (w.getUTCDay() === 3) {
      const d = new Date(Date.UTC(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate(), 14, 30));
      if (!usDst(d)) d.setUTCHours(15);
      if (d.getTime() >= from.getTime()) out.push({ cls: 'eia', t: d.getTime() });
    }
    w.setUTCDate(w.getUTCDate() + 1);
  }
  return out.sort((a, b) => a.t - b.t);
}

// ---------------------------------------------------------------- статистика

/** Квантиль N(0,1) (алгоритм Акляма) — для порога Бонферрони. */
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

// ---------------------------------------------------------------- движок событий

interface Book {
  candles: Candle[];
  idxAtOrBefore: (t: number) => number; // индекс последней минутки с t' <= t
}

function makeBook(candles: Candle[]): Book {
  const ts = candles.map(c => c.t);
  return {
    candles,
    idxAtOrBefore(t: number): number {
      let lo = 0;
      let hi = ts.length - 1;
      if (t < ts[0]) return -1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (ts[mid] <= t) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    },
  };
}

interface Rule {
  shockMin: 5 | 15;   // сколько минут после слота определяют направление шипа
  dir: 'drift' | 'fade';
  entryMode: 'market' | 'limit';
  tpPips: number;     // в масштабе рынка (уже ×mult)
  slPips: number;
}

const HORIZON_MIN = 120;
const LIMIT_TTL_MIN = 3;
const ENTRY_LAG_MIN = 0; // вход сразу по окончании шип-окна

interface EventTrade {
  t: number;
  pnlUsd: number;
  reason: string;
}

/** Одно событие → одна сделка (или null: нет данных/шипа/филла). units=1000, $0.10/пип. */
function runEvent(book: Book, ev: SlotEvent, rule: Rule, mult: number): EventTrade | null {
  const { candles } = book;
  const slotIdx = book.idxAtOrBefore(ev.t - 1);
  if (slotIdx < 1) return null;
  // слот должен попадать в живой рынок: минутка не старше 5 минут до слота
  if (ev.t - candles[slotIdx].t > 5 * 60_000) return null;
  const p0 = candles[slotIdx].c;
  const shockIdx = book.idxAtOrBefore(ev.t + rule.shockMin * 60_000 - 1);
  if (shockIdx <= slotIdx || shockIdx >= candles.length - 3) return null;
  const shock = candles[shockIdx].c - p0;
  const minShock = 3 * mult * PIP; // без внятного шипа события нет
  if (Math.abs(shock) < minShock) return null;
  const dirSign = rule.dir === 'drift' ? Math.sign(shock) : -Math.sign(shock);
  const side: 'BUY' | 'SELL' = dirSign > 0 ? 'BUY' : 'SELL';

  const entryAt = ev.t + (rule.shockMin + ENTRY_LAG_MIN) * 60_000;
  let entryIdx = book.idxAtOrBefore(entryAt);
  if (entryIdx >= candles.length - 2) return null;
  let entry: number;
  if (rule.entryMode === 'market') {
    const c = candles[entryIdx];
    const half = (c.sp ?? PIP) / 2;
    entry = side === 'BUY' ? c.c + half : c.c - half; // платим реальный полуспред момента
    entryIdx += 1;
  } else {
    // лимитка на пассивной стороне от mid; филл по касанию в ближайшие TTL минут
    const c = candles[entryIdx];
    const half = (c.sp ?? PIP) / 2;
    const price = side === 'BUY' ? c.c - half : c.c + half;
    let filled = -1;
    for (let i = entryIdx + 1; i <= Math.min(entryIdx + LIMIT_TTL_MIN, candles.length - 1); i++) {
      const half2 = (candles[i].sp ?? PIP) / 2;
      const touch = side === 'BUY' ? candles[i].l - half2 <= price : candles[i].h + half2 >= price;
      if (touch) {
        filled = i;
        break;
      }
    }
    if (filled < 0) return null; // не исполнилась — события нет (честный минус охвата)
    entry = price;
    entryIdx = filled;
  }

  const tp = side === 'BUY' ? entry + rule.tpPips * PIP : entry - rule.tpPips * PIP;
  const sl = side === 'BUY' ? entry - rule.slPips * PIP : entry + rule.slPips * PIP;
  const deadline = ev.t + HORIZON_MIN * 60_000;
  for (let i = entryIdx + 1; i < candles.length; i++) {
    const c = candles[i];
    const half = (c.sp ?? PIP) / 2;
    const hiBid = c.h - half;
    const loBid = c.l - half;
    const hiAsk = c.h + half;
    const loAsk = c.l + half;
    // пессимизм: в одной минутке сначала проверяем SL
    if (side === 'BUY') {
      if (loBid <= sl) return { t: ev.t, pnlUsd: (sl - entry) * 1000, reason: 'SL' };
      if (hiBid >= tp) return { t: ev.t, pnlUsd: (tp - entry) * 1000, reason: 'TP' };
    } else {
      if (hiAsk >= sl) return { t: ev.t, pnlUsd: (entry - sl) * 1000, reason: 'SL' };
      if (loAsk <= tp) return { t: ev.t, pnlUsd: (entry - tp) * 1000, reason: 'TP' };
    }
    if (c.t >= deadline) {
      const exit = side === 'BUY' ? c.c - half : c.c + half;
      return { t: ev.t, pnlUsd: (side === 'BUY' ? exit - entry : entry - exit) * 1000, reason: 'TIME' };
    }
  }
  return null;
}

// ---------------------------------------------------------------- часть A: измерение

function measure(book: Book, events: SlotEvent[], mult: number): {
  n: number;
  path: Record<string, { meanAbs: number; meanSigned: number }>;
  spread: Record<string, number>;
} {
  const marks = [1, 5, 15, 30, 60, 120];
  const spreadMarks = [-5, 1, 5, 15, 30];
  const byMark: Record<string, number[]> = {};
  const spreads: Record<string, number[]> = {};
  let n = 0;
  for (const ev of events) {
    const slotIdx = book.idxAtOrBefore(ev.t - 1);
    if (slotIdx < 1 || ev.t - book.candles[slotIdx].t > 5 * 60_000) continue;
    const p0 = book.candles[slotIdx].c;
    n += 1;
    for (const m of marks) {
      const i = book.idxAtOrBefore(ev.t + m * 60_000 - 1);
      if (i <= slotIdx) continue;
      const move = (book.candles[i].c - p0) / (mult * PIP); // в «единицах волатильности» рынка
      (byMark[`+${m}м`] ??= []).push(move);
    }
    for (const m of spreadMarks) {
      const i = book.idxAtOrBefore(ev.t + m * 60_000 - 1);
      if (i < 0) continue;
      const sp = book.candles[i].sp;
      if (sp !== undefined) (spreads[`${m >= 0 ? '+' : ''}${m}м`] ??= []).push(sp / PIP);
    }
  }
  const avg = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
  return {
    n,
    path: Object.fromEntries(Object.entries(byMark).map(([k, xs]) => [k, {
      meanAbs: +avg(xs.map(Math.abs)).toFixed(1),
      meanSigned: +avg(xs).toFixed(1),
    }])),
    spread: Object.fromEntries(Object.entries(spreads).map(([k, xs]) => [k, +avg(xs).toFixed(2)])),
  };
}

// ---------------------------------------------------------------- главный прогон

function parseArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

const COMBOS: Array<{ pair: string; classes: Array<SlotClass | 'usd-macro'> }> = [
  { pair: 'xauusd', classes: ['nfp', 'fomc', 'usd-macro'] },
  { pair: 'eurusd', classes: ['nfp', 'fomc', 'usd-macro'] },
  { pair: 'lightcmdusd', classes: ['eia', 'usd-macro'] },
];

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  (async () => {
    const from = new Date(parseArg('from') ?? '2024-01-01');
    const to = new Date(parseArg('to') ?? '2026-07-30');
    const allEvents = buildEvents(from, to);
    console.log(`События ${from.toISOString().slice(0, 10)} → ${to.toISOString().slice(0, 10)}: `
      + `NFP ${allEvents.filter(e => e.cls === 'nfp').length}, FOMC ${allEvents.filter(e => e.cls === 'fomc').length}, `
      + `EIA ${allEvents.filter(e => e.cls === 'eia').length}`);

    // грид правил (одинаковый для всех рынков, pips ×mult рынка)
    const rulesBase: Array<Omit<Rule, 'tpPips' | 'slPips'> & { tp: number; sl: number }> = [];
    for (const shockMin of [5, 15] as const) {
      for (const dir of ['drift', 'fade'] as const) {
        for (const entryMode of ['market', 'limit'] as const) {
          for (const tp of [10, 20]) {
            for (const sl of [20, 40]) rulesBase.push({ shockMin, dir, entryMode, tp, sl });
          }
        }
      }
    }
    const totalCells = COMBOS.reduce((s, c) => s + c.classes.length, 0) * rulesBase.length;
    const alpha = 0.05 / totalCells;
    const zBonf = normalQuantile(1 - alpha / 2);
    console.log(`Ячеек: ${totalCells} → Бонферрони α=${alpha.toExponential(1)}, порог |t|≥${zBonf.toFixed(2)}\n`);

    const report: any = { from, to, zBonf, cells: [], measure: {} };

    for (const combo of COMBOS) {
      const market = MARKETS[combo.pair];
      const mult = market.pipsMult ?? 1;
      const raw = await loadM1WithSpread(market.instrument, from, to);
      const candles = prepCandles(raw, market);
      const book = makeBook(candles);

      for (const clsName of combo.classes) {
        const events = clsName === 'usd-macro'
          ? allEvents.filter(e => e.cls === 'nfp' || e.cls === 'fomc')
          : allEvents.filter(e => e.cls === clsName);

        const m = measure(book, events, mult);
        report.measure[`${combo.pair}/${clsName}`] = m;
        console.log(`===== ${combo.pair} × ${clsName}: ${m.n} событий (mult ${mult}) =====`);
        console.log(`  путь (пипсы×mult, знак=среднее): ${Object.entries(m.path).map(([k, v]) => `${k} |${v.meanAbs}| (${v.meanSigned >= 0 ? '+' : ''}${v.meanSigned})`).join(' · ')}`);
        console.log(`  спред (пипсы): ${Object.entries(m.spread).map(([k, v]) => `${k}: ${v}`).join(' · ')}`);

        for (const rb of rulesBase) {
          const rule: Rule = { shockMin: rb.shockMin, dir: rb.dir, entryMode: rb.entryMode, tpPips: rb.tp * mult, slPips: rb.sl * mult };
          const trades = events.map(ev => runEvent(book, ev, rule, mult)).filter((x): x is EventTrade => x !== null);
          if (trades.length < 10) continue;
          const cut = Math.floor(trades.length * 0.7);
          const train = trades.slice(0, cut);
          const test = trades.slice(cut);
          if (train.length < 8 || test.length < 4) continue;
          const trainPnl = train.map(x => x.pnlUsd);
          const testPnl = test.map(x => x.pnlUsd);
          const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
          const cell = {
            pair: combo.pair,
            cls: clsName,
            rule: `${rb.dir}/${rb.entryMode} shock${rb.shockMin}м tp${rb.tp} sl${rb.sl}`,
            n: trades.length,
            trainNet: +sum(trainPnl).toFixed(2),
            trainT: +tStat(trainPnl).toFixed(2),
            testNet: +sum(testPnl).toFixed(2),
            testN: test.length,
            pass: sum(trainPnl) > 0 && Math.abs(tStat(trainPnl)) >= zBonf && sum(testPnl) > 0,
          };
          report.cells.push(cell);
          if (cell.pass || (cell.trainNet > 0 && cell.testNet > 0 && Math.abs(cell.trainT) >= 2)) {
            console.log(`  ${cell.pass ? '✅ ПРОШЛА' : '· кандидат (без Бонферрони)'} ${cell.rule}: `
              + `train ${cell.trainNet}$ (t=${cell.trainT}, n=${train.length}) · test ${cell.testNet}$ (n=${test.length})`);
          }
        }
        console.log('');
      }
    }

    const passed = report.cells.filter((c: any) => c.pass);
    console.log(`ИТОГ: ячеек с данными ${report.cells.length}, прошли строгий фильтр (train>0 ∧ |t|≥${zBonf.toFixed(2)} ∧ test>0): ${passed.length}`);
    for (const p of passed) console.log(`  ✅ ${p.pair} × ${p.cls} × ${p.rule}: train ${p.trainNet}$ (t=${p.trainT}) test ${p.testNet}$`);

    const outPath = path.join(process.cwd(), 'data', 'news-slots-report.json');
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(report, null, 1));
    console.log(`\nJSON: ${outPath}\nDONE`);
  })().catch(e => {
    console.error(e);
    process.exit(1);
  });
}
