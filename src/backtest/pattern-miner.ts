// Промышленный паттерн-майнер (рамка владельца 22.08: «задача не протестировать
// 20-30, а найти 1-2 лупом из любого числа»). Условные паттерны минутных
// возвратов на всех инструментах с историей. Правила зафиксированы ДО прогона:
//
// - алфавиты: bin (знак возврата, нулевые бары выброшены) L∈{3..8};
//   quat (знак × амплитуда: большой/малый по медиане |r| ТОЛЬКО train) L∈{3,4,5}
// - горизонты H∈{1,3,5,10,30} минут вперёд (сумма лог-возвратов)
// - непрерывность: паттерн+таргет в пределах 3×(L+H) минут
// - train < 2026-06-01, test = июнь..август
// - stage1: n_train≥300 и |t_train|/√H ≥ z Бонферрони по ФАКТИЧЕСКОМУ числу
//   протестированных (√H — консервативная поправка на перекрытие таргетов)
// - stage2: n_test≥100, тот же знак, |t_test|/√H ≥ 2
// - stage3 (экономика — урок марков-прогона 22.08): |mean_train| > cost И
//   |mean_test| > cost, где cost = полный круг издержек долей цены
//   (FX/CFD: консервативный спред; MOEX: живой медианный спред + 0.1% комиссия)
//
// Итог прогона 22.08 (data/pattern-miner-result.json): 203 280 гипотез,
// stage1 2886, stage2 1495, stage3 (край > издержек) — НОЛЬ. Микроструктурная
// осцилляция РФ-малоликвидов (SVCB/TRNFP) статистически железная (t до 38 на
// train, до 13 на test), но 3-6бп края против 13-15бп издержек. Вся память —
// на горизонте 1 минуты; на H≥10 условной памяти нет нигде.
//
// CLI: npx tsx src/backtest/pattern-miner.ts

import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadMoexM1 } from './moex-data';
import { loadM1 } from './data';

const TRAIN_END = Date.parse('2026-06-01T00:00:00Z');
const FROM = new Date('2024-06-01');
const BIN_LS = [3, 4, 5, 6, 7, 8];
const QUAT_LS = [3, 4, 5];
const HS = [1, 3, 5, 10, 30];

interface Instr { name: string; kind: 'duka' | 'moex'; id: string; cost: number }
const INSTRS: Instr[] = [
  { name: 'EURUSD', kind: 'duka', id: 'eurusd', cost: 0.0001 },
  { name: 'GBPJPY', kind: 'duka', id: 'gbpjpy', cost: 0.0001 },
  { name: 'XAUUSD', kind: 'duka', id: 'xauusd', cost: 0.00012 },
  { name: 'WTI', kind: 'duka', id: 'lightcmdusd', cost: 0.0006 },
  { name: 'SP500', kind: 'duka', id: 'usa500idxusd', cost: 0.0001 },
  { name: 'EURJPY', kind: 'duka', id: 'eurjpy', cost: 0.0001 },
  { name: 'AUDJPY', kind: 'duka', id: 'audjpy', cost: 0.0001 },
  { name: 'GBPNZD', kind: 'duka', id: 'gbpnzd', cost: 0.00025 },
  { name: 'JP225', kind: 'duka', id: 'jpnidxjpy', cost: 0.00015 },
  { name: 'BTC', kind: 'duka', id: 'btcusd', cost: 0.0002 },
  { name: 'ETH', kind: 'duka', id: 'ethusd', cost: 0.0003 },
  // MOEX: живой медианный спред (замер 05.08) + 0.001 комиссия за круг
  { name: 'AFKS', kind: 'moex', id: 'AFKS', cost: 0.00021 + 0.001 },
  { name: 'GAZP', kind: 'moex', id: 'GAZP', cost: 0.00011 + 0.001 },
  { name: 'MOEX', kind: 'moex', id: 'MOEX', cost: 0.00025 + 0.001 },
  { name: 'TRNFP', kind: 'moex', id: 'TRNFP', cost: 0.00018 + 0.001 },
  { name: 'SVCB', kind: 'moex', id: 'SVCB', cost: 0.00048 + 0.001 },
  { name: 'SIBN', kind: 'moex', id: 'SIBN', cost: 0.00032 + 0.001 },
  { name: 'ALRS', kind: 'moex', id: 'ALRS', cost: 0.00044 + 0.001 },
  { name: 'TATN', kind: 'moex', id: 'TATN', cost: 0.00019 + 0.001 },
  { name: 'ROSN', kind: 'moex', id: 'ROSN', cost: 0.00014 + 0.001 },
  { name: 'SNGS', kind: 'moex', id: 'SNGS', cost: 0.00032 + 0.001 },
  { name: 'RAGR', kind: 'moex', id: 'RAGR', cost: 0.0004 + 0.001 },
];

// хвостовая асимптотика erfc (x>3, три члена) → z по двустороннему α бисекцией
function erfcAsym(x: number): number {
  const x2 = x * x;
  return Math.exp(-x2) / (x * Math.sqrt(Math.PI)) * (1 - 0.5 / x2 + 0.75 / (x2 * x2));
}
function zForAlpha(alpha: number): number {
  let lo = 3, hi = 12;
  for (let k = 0; k < 200; k++) {
    const mid = (lo + hi) / 2;
    if (erfcAsym(mid / Math.SQRT2) > alpha) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

interface Acc { n: number; s: number; s2: number }
interface Hyp {
  instr: string; alphabet: string; L: number; H: number; pattern: string; cost: number;
  nTr: number; meanTr: number; tTr: number; nTe: number; meanTe: number; tTe: number;
}
const stats = (a: Acc) => {
  const mean = a.s / a.n;
  const va = Math.max(a.s2 / a.n - mean * mean, 1e-20);
  return { mean, t: mean / Math.sqrt(va / a.n) };
};

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  (async () => {
    let tested = 0;
    const all: Hyp[] = []; // кандидаты с n_train≥300 (в леджер считаются ВСЕ увиденные)

    for (const ins of INSTRS) {
      let candles: Array<{ t: number; c: number }>;
      try {
        candles = ins.kind === 'moex'
          ? await loadMoexM1(ins.id, FROM, new Date())
          : await loadM1(ins.id, FROM, new Date(), 'bid');
      } catch (e) {
        console.log(`${ins.name}: история не загрузилась (${(e as Error).message}) — пропуск`);
        continue;
      }
      // лог-возвраты close→close, нулевые выброшены (конвенция марков-прогона)
      const seq: Array<{ t: number; r: number }> = [];
      for (let j = 1; j < candles.length; j++) {
        const r = Math.log(candles[j].c / candles[j - 1].c);
        if (r !== 0 && Number.isFinite(r)) seq.push({ t: candles[j].t, r });
      }
      candles = []; // историю больше не держим — освобождаем память до следующего инструмента
      if (seq.length < 50_000) { console.log(`${ins.name}: мало данных (${seq.length}) — пропуск`); continue; }
      // порог амплитуды quat-алфавита: медиана |r| ТОЛЬКО на train
      const absTr = seq.filter(x => x.t < TRAIN_END).map(x => Math.abs(x.r)).sort((a, b) => a - b);
      const ampMed = absTr[Math.floor(absTr.length / 2)];
      const binS = seq.map(x => (x.r > 0 ? 1 : 0));
      const quatS = seq.map(x => (x.r > 0 ? (Math.abs(x.r) >= ampMed ? 3 : 2) : (Math.abs(x.r) >= ampMed ? 1 : 0)));
      const C: number[] = new Array(seq.length + 1);
      C[0] = 0;
      for (let j = 0; j < seq.length; j++) C[j + 1] = C[j] + seq[j].r;

      let insTested = 0;
      for (const [alphabet, states, Ls] of [['bin', binS, BIN_LS], ['quat', quatS, QUAT_LS]] as const) {
        for (const L of Ls) {
          for (const H of HS) {
            const tr = new Map<string, Acc>();
            const te = new Map<string, Acc>();
            const maxSpan = (L + H) * 3 * 60_000;
            for (let i = L; i + H - 1 < seq.length; i++) {
              if (seq[i + H - 1].t - seq[i - L].t > maxSpan) continue;
              let key = '';
              for (let k = i - L; k < i; k++) key += states[k];
              const target = C[i + H] - C[i];
              const m = seq[i].t < TRAIN_END ? tr : te;
              const cur = m.get(key);
              if (cur) { cur.n += 1; cur.s += target; cur.s2 += target * target; }
              else m.set(key, { n: 1, s: target, s2: target * target });
            }
            insTested += tr.size;
            const sqH = Math.sqrt(H);
            for (const [key, a] of tr) {
              if (a.n < 300) continue;
              const { mean, t } = stats(a);
              const b = te.get(key);
              const st = b && b.n >= 100 ? stats(b) : null;
              all.push({
                instr: ins.name, alphabet, L, H, pattern: key, cost: ins.cost,
                nTr: a.n, meanTr: mean, tTr: t / sqH,
                nTe: b?.n ?? 0, meanTe: st?.mean ?? 0, tTe: st ? st.t / sqH : 0,
              });
            }
          }
        }
      }
      tested += insTested;
      console.log(`${ins.name}: ${seq.length} ненулевых минуток, паттернов протестировано ${insTested}`);
    }

    const zBonf = zForAlpha(0.05 / Math.max(tested, 1));
    console.log(`\nВСЕГО протестировано: ${tested} · порог Бонферрони |t|≥${zBonf.toFixed(2)}`);

    const s1 = all.filter(h => Math.abs(h.tTr) >= zBonf);
    const s2 = s1.filter(h => h.nTe >= 100 && Math.sign(h.meanTe) === Math.sign(h.meanTr) && Math.abs(h.tTe) >= 2);
    const s3 = s2.filter(h => Math.abs(h.meanTr) > h.cost && Math.abs(h.meanTe) > h.cost);
    console.log(`stage1 (train значим): ${s1.length}`);
    console.log(`stage2 (+знак и |t|≥2 на test): ${s2.length}`);
    console.log(`stage3 (ФИНАЛ: край > издержек на train И test): ${s3.length}`);

    const fmt = (h: Hyp) =>
      `${h.instr} ${h.alphabet} L${h.L} H${h.H} [${h.pattern}]: train ${(h.meanTr * 1e4).toFixed(2)}бп/сд (n=${h.nTr}, t=${h.tTr.toFixed(1)}) · ` +
      `test ${(h.meanTe * 1e4).toFixed(2)}бп (n=${h.nTe}, t=${h.tTe.toFixed(1)}) · издержки ${(h.cost * 1e4).toFixed(1)}бп · запас ×${(Math.abs(h.meanTe) / h.cost).toFixed(2)}`;

    console.log('\n— stage2 (стат-выжившие, но экономику ещё не прошли):');
    for (const h of s2.slice().sort((a, b) => Math.abs(b.meanTe) / b.cost - Math.abs(a.meanTe) / a.cost).slice(0, 25)) console.log('  ' + fmt(h));
    console.log('\n=== ФИНАЛИСТЫ stage3 ===' + (s3.length ? '' : ' НЕТ'));
    for (const h of s3) console.log('  ✔ ' + fmt(h));

    const outPath = path.join(process.cwd(), 'data', 'pattern-miner-result.json');
    writeFileSync(outPath, JSON.stringify({ tested, zBonf, stage1: s1.length, stage2: s2.length, stage3: s3.length, finalists: s3, stage2Top: s2.slice(0, 200) }, null, 1));
    console.log(`\nJSON: ${outPath}\nDONE`);
  })().catch(e => {
    console.error(e);
    process.exit(1);
  });
}
