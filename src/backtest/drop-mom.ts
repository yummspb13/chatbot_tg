// Прогон интуиции владельца (20.08): «цена сильно пошла за N минут → ловим
// продолжение в ту же сторону на M минут». Симметрично в обе стороны (SELL на
// падении, BUY на росте), с реальными издержками РФ: медианный спред живых
// стаканов + комиссия 0.1% за круг. Walk-forward: train до 2026-06, test дальше.
//
// Сетка: N∈{5,15,30,60} × X∈{0.4%,0.8%,1.2%} × M∈{15,30,60} = 36 ячеек × 11
// бумаг = 396 гипотез — батч уходит в кумулятивный леджер Бонферрони.
// Правило выживания (зафиксировано ДО прогона): net>0 на train И test, n_test≥20.
//
// CLI: npx tsx src/backtest/drop-mom.ts

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadMoexM1 } from './moex-data';

const TICKERS = ['TATN', 'GAZP', 'ROSN', 'AFKS', 'MOEX', 'TRNFP', 'SVCB', 'SNGS', 'RAGR', 'SIBN', 'ALRS'];
// медианные спреды живых стаканов (замер 05.08, доля цены) — как в moexleg
const SPREAD: Record<string, number> = {
  TATN: 0.00019, GAZP: 0.00011, ROSN: 0.00014, AFKS: 0.00021, MOEX: 0.00025,
  TRNFP: 0.00018, SVCB: 0.00048, SNGS: 0.00032, RAGR: 0.0004, SIBN: 0.00032, ALRS: 0.00044,
};
const COMMISSION_RT = 0.001; // 0.1% за круг — РФ-модель всех наших MOEX-прогонов

const NS = [5, 15, 30, 60];
const XS = [0.004, 0.008, 0.012];
const MS = [15, 30, 60];
const TRAIN_END = Date.parse('2026-06-01T00:00:00Z');

interface CellStat { n: number; net: number; wins: number }

function simulate(candles: { t: number; o: number; h: number; l: number; c: number }[], spreadFrac: number,
  N: number, X: number, M: number): { train: CellStat; test: CellStat } {
  const train: CellStat = { n: 0, net: 0, wins: 0 };
  const test: CellStat = { n: 0, net: 0, wins: 0 };
  const cost = spreadFrac + COMMISSION_RT; // спред целиком + комиссия круга
  let blockedUntil = 0;
  for (let i = N; i < candles.length - M - 1; i++) {
    const cur = candles[i];
    if (cur.t < blockedUntil) continue;
    const past = candles[i - N];
    // соседство по времени: разрыв окна (ночь/выходные) — сигнал не считаем
    if (cur.t - past.t > N * 60_000 * 3) continue;
    const ret = (cur.c - past.c) / past.c;
    let dir: 1 | -1 | 0 = 0;
    if (ret <= -X) dir = -1;      // сильно упало → продолжаем вниз (SELL)
    else if (ret >= X) dir = 1;   // сильно выросло → продолжаем вверх (BUY)
    if (dir === 0) continue;
    const entry = cur.c;
    const stop = entry * (1 - dir * X / 2);
    let exit: number | null = null;
    for (let j = i + 1; j <= i + M && j < candles.length; j++) {
      const b = candles[j];
      if (b.t - cur.t > M * 60_000 * 3) break; // разрыв — закрываем по последней
      if (dir === 1 ? b.l <= stop : b.h >= stop) { exit = stop; break; }
      exit = b.c;
    }
    if (exit === null) continue;
    const pnl = dir * (exit - entry) / entry - cost;
    const s = cur.t < TRAIN_END ? train : test;
    s.n += 1;
    s.net += pnl;
    if (pnl > 0) s.wins += 1;
    blockedUntil = cur.t + (M + N) * 60_000; // кулдаун: один эпизод — одна сделка
  }
  return { train, test };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  (async () => {
    const rows: string[] = [];
    const survivors: string[] = [];
    let cells = 0;
    for (const ticker of TICKERS) {
      const candles = await loadMoexM1(ticker, new Date('2024-01-01'), new Date());
      if (candles.length < 50_000) {
        console.log(`${ticker}: мало истории (${candles.length}) — пропуск`);
        continue;
      }
      let best = { key: '', testNet: -1 };
      for (const N of NS) for (const X of XS) for (const M of MS) {
        cells += 1;
        const { train, test } = simulate(candles, SPREAD[ticker] ?? 0.0003, N, X, M);
        const key = `${ticker} N${N} X${(X * 100).toFixed(1)}% M${M}`;
        const line = `${key}: train ${train.n} сд net ${(train.net * 100).toFixed(2)}% · test ${test.n} сд net ${(test.net * 100).toFixed(2)}% wr ${test.n ? Math.round(100 * test.wins / test.n) : 0}%`;
        rows.push(line);
        if (train.net > 0 && test.net > 0 && test.n >= 20) survivors.push(line);
        if (test.net > best.testNet) best = { key: line, testNet: test.net };
      }
      console.log(`${ticker}: лучшая ячейка → ${best.key}`);
    }
    console.log(`\nячеек прогнано: ${cells} · ВЫЖИВШИХ (train>0 & test>0 & n≥20): ${survivors.length}`);
    for (const s of survivors) console.log('  ✔ ' + s);

    const report = [
      `# Drop-momentum по интуиции владельца («ловим продолжение хода»), ${new Date().toISOString().slice(0, 10)}`,
      '',
      `Сетка ${cells} ячеек × walk-forward (train 2024-01→2026-05, test 2026-06→сейчас), издержки: медианный спред + 0.1% круг.`,
      `Правило выживания (до прогона): net>0 на train И test, n_test≥20.`,
      '',
      `## Выжившие: ${survivors.length}`,
      ...survivors.map(s => '- ' + s),
      '',
      '## Все ячейки',
      ...rows.map(r => '- ' + r),
    ].join('\n');
    writeFileSync(`docs/DROP-MOM-${new Date().toISOString().slice(0, 10)}.md`, report);

    const ledger = JSON.parse(readFileSync('data/hypothesis-ledger.json', 'utf8'));
    ledger.totalTested += cells;
    ledger.batches.push({
      id: `drop-momentum MOEX (идея владельца: «ловить продолжение сильного хода», ${cells} ячеек, 11 бумаг)`,
      when: new Date().toISOString().slice(0, 10),
      n: cells, stage1: survivors.length, stage2: 0, lockboxWins: 0,
    });
    writeFileSync('data/hypothesis-ledger.json', JSON.stringify(ledger, null, 1));
    console.log(`\nледжер: ${ledger.totalTested} · отчёт: docs/DROP-MOM-${new Date().toISOString().slice(0, 10)}.md`);
    process.exit(0);
  })().catch(e => {
    console.error(e);
    process.exit(1);
  });
}
