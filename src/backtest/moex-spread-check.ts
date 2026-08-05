// Валидация спред-модели MOEX-сканов живыми стаканами (T-Invest, read-only).
//
// Полный скан 36 бумаг (docs/MOEX-FULL-2026-08-05.md) прошёл на константной
// модели спреда 0.02%. У второго эшелона (SPBE, SVAV, AFKS...) реальный стакан
// может быть в разы шире — тогда их «проходы» — артефакт льстивой модели.
// Замер: каждые 30с в течение ~20 мин снимаем верх стакана тикеров-победителей,
// считаем средний/медианный/p90 спред в % цены, сравниваем с моделью и
// пересчитываем вердикт: у кого комиссия+РЕАЛЬНЫЙ спред всё ещё оставляет
// ячейке плюс.
//
// CLI: TINKOFF_TOKEN=... npx tsx src/backtest/moex-spread-check.ts [--minutes 20]

import { pathToFileURL } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { TinkoffClient } from '../broker/tinkoff';
import { moexInSession } from '../agent/moexleg';

const WINNERS = ['AFKS', 'SVCB', 'MOEX', 'SPBE', 'SVAV', 'SNGS', 'RAGR', 'SGZH', 'TRNFP', 'SIBN', 'ALRS', 'T', 'GAZP', 'ROSN', 'TATN'];
const MODEL_FRAC = 0.0002; // 0.02% — модель скана

function quantile(xs: number[], q: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))];
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  (async () => {
    const token = process.env.TINKOFF_TOKEN;
    if (!token) throw new Error('нужен TINKOFF_TOKEN');
    const minutes = Number(process.argv.includes('--minutes') ? process.argv[process.argv.indexOf('--minutes') + 1] : 20);
    if (!moexInSession(new Date())) {
      console.log('Сессия Мосбиржи закрыта — замер спредов не имеет смысла, выходим.');
      return;
    }
    const client = new TinkoffClient(token);
    const uids = new Map<string, string>();
    for (const t of WINNERS) {
      try {
        uids.set(t, await client.shareUid(t));
      } catch (e) {
        console.log(`  ${t}: uid не найден (${(e as Error).message?.slice(0, 50)})`);
      }
    }
    console.log(`Замер спредов: ${uids.size} тикеров, ~${minutes} мин по 30с...`);

    const samples = new Map<string, number[]>();
    const rounds = Math.max(4, Math.round((minutes * 60) / 30));
    for (let r = 0; r < rounds; r++) {
      for (const [ticker, uid] of uids) {
        try {
          const top = await client.orderBookTop(uid);
          if (top.bid !== null && top.ask !== null && top.ask > top.bid) {
            const frac = (top.ask - top.bid) / ((top.ask + top.bid) / 2);
            (samples.get(ticker) ?? samples.set(ticker, []).get(ticker)!).push(frac);
          }
        } catch {
          // пропуск замера
        }
      }
      if (r < rounds - 1) await new Promise(res => setTimeout(res, 30_000));
    }
    await client.shutdown();

    console.log('\nТикер   · замеров · медиана · p90 · ×модели(0.02%) · вердикт');
    const rows: any[] = [];
    for (const [ticker, xs] of samples) {
      const med = quantile(xs, 0.5);
      const p90 = quantile(xs, 0.9);
      const ratio = med / MODEL_FRAC;
      const verdict = ratio <= 1.5 ? '✅ модель честна' : ratio <= 3 ? '⚠️ спред ×' + ratio.toFixed(1) + ' — пересчитать' : '❌ модель льстила ×' + ratio.toFixed(1);
      rows.push({ ticker, n: xs.length, medianPct: +(med * 100).toFixed(4), p90Pct: +(p90 * 100).toFixed(4), xModel: +ratio.toFixed(2), verdict });
      console.log(`${ticker.padEnd(7)} · ${String(xs.length).padStart(3)} · ${(med * 100).toFixed(3)}% · ${(p90 * 100).toFixed(3)}% · ×${ratio.toFixed(1)} · ${verdict}`);
    }

    const outPath = path.join(process.cwd(), 'data', 'moex-spread-check.json');
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify({ asOf: new Date().toISOString(), modelFrac: MODEL_FRAC, rows }, null, 1));
    console.log(`\nJSON: ${outPath}\nDONE`);
  })().catch(e => {
    console.error(e);
    process.exit(1);
  });
}
