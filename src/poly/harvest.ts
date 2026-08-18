// Харвестер истории Polymarket 5-минуток (план M4). Запуск ЛОКАЛЬНО/из сессии
// разработки — трафик НЕ идёт через Render. Прямой перебор слагов по сетке
// таймстемпов (зонд 18.08: gamma отдаёт closed-рынки по слагу минимум на 30
// дней назад; пагинация marketsClosed с tag_slug=crypto бесполезна — шум).
//
// Кэш: data/poly-history/<asset>.jsonl — append-only, по строке на бакет:
//   {"slug","ts","endTs","outcome","closeUpPrice","q"} | {"slug","ts","missing":true}
// Повторный запуск дотягивает только недостающие слаги (идемпотентно).
// Заливка в PolyResolution — отдельным шагом (execute_sql батчами, см. план).
//
// Запуск: npx tsx src/poly/harvest.ts --asset btc --days 7
//         npx tsx src/poly/harvest.ts --asset eth --days 7 --throttle 400

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { errMsg } from '../logger';
import { sleep } from '../broker/types';
import { PolyClient } from './client';
import { BUCKET_SEC, bucketStart, slugFor } from './markets';

const HIST_DIR = path.join(process.cwd(), 'data', 'poly-history');

export interface HistRow {
  slug: string;
  ts: number;              // unix старта бакета (из слага)
  endTs?: string;          // ISO конца рынка (gamma endDate)
  outcome?: 'up' | 'down';
  closeUpPrice?: number;   // сеттл UP: 1|0 (outcomePrices[0])
  q?: string;              // question — перекрёстная проверка времени ET
  missing?: boolean;       // рынка нет/не закрыт — честная дырка
}

export function histFile(asset: string): string {
  return path.join(HIST_DIR, `${asset}.jsonl`);
}

/** Читает кэш актива; при дублях слага побеждает последняя строка. */
export function loadHist(asset: string): Map<string, HistRow> {
  const map = new Map<string, HistRow>();
  const f = histFile(asset);
  if (!existsSync(f)) return map;
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as HistRow;
      map.set(r.slug, r);
    } catch {
      // битая строка (оборванный append) — пропускаем молча
    }
  }
  return map;
}

export interface HarvestOpts {
  asset: string;
  fromTs: number;      // unix первого бакета (включительно)
  toTs: number;        // unix последнего бакета (включительно)
  throttleMs: number;
  refetchMissing?: boolean; // перепросить и дырки (по умолчанию нет)
  log?: (s: string) => void;
}

/** Дотягивает недостающие бакеты сетки в кэш. Возвращает статистику прохода. */
export async function harvest(client: PolyClient, o: HarvestOpts) {
  const say = o.log ?? (() => {});
  mkdirSync(HIST_DIR, { recursive: true });
  const have = loadHist(o.asset);
  const want: number[] = [];
  for (let ts = o.fromTs; ts <= o.toTs; ts += BUCKET_SEC) {
    const ex = have.get(slugFor(o.asset, ts));
    if (!ex || (o.refetchMissing && ex.missing)) want.push(ts);
  }
  say(`${o.asset}: в кэше ${have.size}, догружаем ${want.length} бакетов (троттлинг ${o.throttleMs}мс)`);
  let done = 0;
  let okCount = 0;
  let missCount = 0;
  let errStreak = 0;
  for (const ts of want) {
    const slug = slugFor(o.asset, ts);
    try {
      const m = await client.marketBySlug(slug);
      let row: HistRow;
      if (m && m.closed && m.outcomePrices) {
        const upPrice = Number((JSON.parse(m.outcomePrices) as string[])[0]);
        row = {
          slug, ts, endTs: m.endDate,
          outcome: upPrice > 0.5 ? 'up' : 'down',
          closeUpPrice: upPrice, q: m.question,
        };
        okCount += 1;
      } else {
        row = { slug, ts, missing: true };
        missCount += 1;
      }
      appendFileSync(histFile(o.asset), JSON.stringify(row) + '\n');
      errStreak = 0;
    } catch (e) {
      errStreak += 1;
      say(`  ${slug}: ${errMsg(e)} (стрик ${errStreak})`);
      if (errStreak >= 8) {
        say('  8 ошибок подряд — стоп прохода (кэш цел, продолжим следующим запуском)');
        break;
      }
      await sleep(5000);
    }
    done += 1;
    if (done % 100 === 0) say(`  ${o.asset}: ${done}/${want.length} (ok ${okCount}, дырок ${missCount}, req/мин ${client.counters().perMin})`);
    await sleep(o.throttleMs);
  }
  return { asked: want.length, done, okCount, missCount, cached: have.size };
}

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  (async () => {
    const asset = arg('asset', 'btc');
    const days = Number(arg('days', '7'));
    const throttleMs = Number(arg('throttle', '380'));
    // не лезем в 2 самых свежих бакета — их доберёт live-коллектор.
    // from строго на сетке 300с: шаг цикла прибавляет BUCKET_SEC от from,
    // невыровненный старт даёт несуществующие слаги (первый прогон это поймал)
    const to = bucketStart(Date.now()) - 2 * BUCKET_SEC;
    const buckets = Math.max(1, Math.round(days * 86400 / BUCKET_SEC));
    const from = to - (buckets - 1) * BUCKET_SEC;
    const client = new PolyClient();
    const t0 = Date.now();
    const res = await harvest(client, {
      asset, fromTs: from, toTs: to, throttleMs,
      refetchMissing: process.argv.includes('--refetch-missing'),
      log: s => console.log(s),
    });
    console.log(`\nитог ${asset}: запрошено ${res.asked}, готово ${res.done}, исходов ${res.okCount}, дырок ${res.missCount}, было в кэше ${res.cached}`);
    console.log(`время ${(Math.round((Date.now() - t0) / 1000 / 60 * 10) / 10)} мин · счётчики: ${JSON.stringify(client.counters())}`);
    await client.shutdown();
    process.exit(0);
  })().catch(e => {
    console.error(e);
    process.exit(1);
  });
}
