// Калибровка кандидатов на расширение: «неочевидные» рынки против нашего
// главного фильтра — cost ratio = спред Exness ÷ медианный часовой ход.
//
// Этот фильтр уже дважды предсказал исход до свипа: USDJPY (ratio ~0.5) — всё
// красное; XAUUSD (лучший ratio) — победитель. Теперь тот же градусник для
// 20 кроссов без доллара, 10 экзотик и 5 новых индексов. Тезис владельца:
// менее замусоленные рынки паттернистее (GBPJPY час-20 — подтверждение);
// антитезис: у экзотики спред растёт быстрее хода. Меряем, не спорим.
//
// Ход — из Dukascopy M1 (июнь-июль 2026, как в калибровке 01.08);
// спред — ЖИВОЙ с вашего счёта Exness через MetaApi (снимок на момент прогона;
// у закрытых в этот час рынков — спред последней котировки, помечаем).
//
// CLI: METAAPI_TOKEN=... METAAPI_ACCOUNT_ID=... npx tsx src/backtest/calibrate.ts

import { pathToFileURL } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { request } from 'undici';
import { loadM1 } from './data';

interface Candidate {
  group: 'кросс' | 'экзотика' | 'индекс';
  exness: string;
  duk: string;
}

const CANDIDATES: Candidate[] = [
  // кроссы без доллара
  ...['eurjpy', 'gbpchf', 'audjpy', 'cadjpy', 'chfjpy', 'nzdjpy', 'euraud', 'eurcad', 'eurchf', 'eurgbp',
    'eurnzd', 'gbpaud', 'gbpcad', 'gbpnzd', 'audcad', 'audchf', 'audnzd', 'cadchf', 'nzdcad', 'nzdchf']
    .map((duk): Candidate => ({ group: 'кросс', duk, exness: duk.toUpperCase() + 'm' })),
  // экзотика
  ...['usdtry', 'usdzar', 'usdmxn', 'usdpln', 'usdhuf', 'usdczk', 'usdsgd', 'usdhkd', 'eurtry', 'eurpln']
    .map((duk): Candidate => ({ group: 'экзотика', duk, exness: duk.toUpperCase() + 'm' })),
  // индексы
  { group: 'индекс', duk: 'jpnidxjpy', exness: 'JP225m' },
  { group: 'индекс', duk: 'hkgidxhkd', exness: 'HK50m' },
  { group: 'индекс', duk: 'deuidxeur', exness: 'DE30m' },
  { group: 'индекс', duk: 'gbridxgbp', exness: 'UK100m' },
  { group: 'индекс', duk: 'eusidxeur', exness: 'STOXX50m' },
];

async function exnessPrice(token: string, accountId: string, symbol: string): Promise<{ bid: number; ask: number } | null> {
  const url = `https://mt-client-api-v1.london.agiliumtrade.ai/users/current/accounts/${accountId}/symbols/${encodeURIComponent(symbol)}/current-price?keepSubscription=false`;
  try {
    const res = await request(url, { headers: { 'auth-token': token }, headersTimeout: 20_000, bodyTimeout: 20_000 });
    const text = await res.body.text();
    if (res.statusCode !== 200) return null;
    const j = JSON.parse(text);
    if (!Number.isFinite(j.bid) || !Number.isFinite(j.ask)) return null;
    return { bid: j.bid, ask: j.ask };
  } catch {
    return null;
  }
}

/** Медианный часовой ход (high-low по часовым корзинам) в сырых ценах. */
function medianHourlyMove(candles: Array<{ t: number; h: number; l: number }>): number {
  const byHour = new Map<number, { hi: number; lo: number }>();
  for (const c of candles) {
    const k = Math.floor(c.t / 3600_000);
    const cur = byHour.get(k);
    if (!cur) byHour.set(k, { hi: c.h, lo: c.l });
    else {
      cur.hi = Math.max(cur.hi, c.h);
      cur.lo = Math.min(cur.lo, c.l);
    }
  }
  const moves = [...byHour.values()].map(x => x.hi - x.lo).filter(x => x > 0).sort((a, b) => a - b);
  return moves.length ? moves[Math.floor(moves.length / 2)] : NaN;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  (async () => {
    const token = process.env.METAAPI_TOKEN;
    const accountId = process.env.METAAPI_ACCOUNT_ID;
    if (!token || !accountId) throw new Error('нужны METAAPI_TOKEN и METAAPI_ACCOUNT_ID');
    const from = new Date('2026-06-01');
    const to = new Date('2026-07-30');

    interface Row {
      group: string;
      exness: string;
      duk: string;
      price: number;
      spreadRaw: number;
      spreadPct: number;   // спред в % цены
      moveRaw: number;
      movePct: number;
      ratio: number;       // спред / часовой ход — ГЛАВНОЕ ЧИСЛО
      note: string;
    }
    const rows: Row[] = [];
    for (const c of CANDIDATES) {
      const p = await exnessPrice(token, accountId, c.exness);
      if (!p) {
        console.log(`  ${c.exness}: нет цены у Exness (символа нет или нет доступа) — пропуск`);
        continue;
      }
      let move = NaN;
      let note = '';
      try {
        const candles = await loadM1(c.duk, from, to);
        if (candles.length < 5000) note = `мало истории (${candles.length})`;
        move = medianHourlyMove(candles);
      } catch (e) {
        note = `Dukascopy: ${(e as Error).message?.slice(0, 40)}`;
      }
      const mid = (p.bid + p.ask) / 2;
      const spread = p.ask - p.bid;
      const row: Row = {
        group: c.group, exness: c.exness, duk: c.duk,
        price: +mid.toPrecision(6),
        spreadRaw: +spread.toPrecision(4),
        spreadPct: +(spread / mid * 100).toFixed(4),
        moveRaw: Number.isFinite(move) ? +move.toPrecision(4) : NaN,
        movePct: +(move / mid * 100).toFixed(4),
        ratio: +(spread / move).toFixed(3),
        note,
      };
      rows.push(row);
      console.log(`${c.exness.padEnd(10)} [${c.group}] цена ${row.price} · спред ${row.spreadRaw} (${row.spreadPct}%) · ход/час ${row.moveRaw} (${row.movePct}%) · ratio ${row.ratio} ${note}`);
    }

    rows.sort((a, b) => (a.ratio || 99) - (b.ratio || 99));
    console.log('\n===== РЕЙТИНГ (ratio = спред/часовой ход; наш опыт: ≤0.4 — жизнеспособно, эталоны: золото 0.06, EUR/USD 0.27, GBPJPY 0.40, USDJPY 0.50 — мёртв) =====');
    for (const r of rows) {
      const verdict = !Number.isFinite(r.ratio) ? '—' : r.ratio <= 0.25 ? '✅✅ отлично' : r.ratio <= 0.4 ? '✅ кандидат' : r.ratio <= 0.6 ? '⚠️ на грани' : '❌ спред съест';
      console.log(`  ${r.exness.padEnd(10)} ratio ${String(r.ratio).padEnd(6)} ${verdict} ${r.note}`);
    }

    const outPath = path.join(process.cwd(), 'data', 'calibration-2026-08-03.json');
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify({ asOf: new Date().toISOString(), rows }, null, 1));
    console.log(`\nJSON: ${outPath}\nDONE`);
  })().catch(e => {
    console.error(e);
    process.exit(1);
  });
}
