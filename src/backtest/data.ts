// Загрузка бесплатной истории Dukascopy (EUR/USD, M1) с локальным кэшем.
// CLI: npm run backtest:data -- --from 2024-01-01 --to 2026-07-01

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getHistoricalRates } from 'dukascopy-node';
import { log } from '../logger';

export interface Candle {
  t: number; // unix ms (UTC)
  o: number;
  h: number;
  l: number;
  c: number;
}

export async function loadM1(instrument: string, from: Date, to: Date): Promise<Candle[]> {
  log.info(`загрузка M1 ${instrument}: ${from.toISOString().slice(0, 10)} → ${to.toISOString().slice(0, 10)}`, undefined, 'backtest');
  const rows = await getHistoricalRates({
    instrument: instrument as 'eurusd',
    dates: { from, to },
    timeframe: 'm1',
    format: 'json',
    useCache: true,
    cacheFolderPath: path.join(process.cwd(), 'data', 'dukascopy-cache'),
    batchSize: 20,
    pauseBetweenBatchesMs: 500,
    retryCount: 5,
    pauseBetweenRetriesMs: 1000,
    failAfterRetryCount: false,
  }) as Array<{ timestamp: number; open: number; high: number; low: number; close: number }>;

  const candles = rows
    .filter(r => r && Number.isFinite(r.close) && Number.isFinite(r.open))
    .map(r => ({ t: r.timestamp, o: r.open, h: r.high, l: r.low, c: r.close }));
  log.info(`получено ${candles.length} минуток`, undefined, 'backtest');
  return candles;
}

function parseArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const from = new Date(parseArg('from') ?? '2024-01-01');
  const to = new Date(parseArg('to') ?? new Date().toISOString().slice(0, 10));
  const instrument = (parseArg('pair') ?? 'eurusd').toLowerCase();
  loadM1(instrument, from, to)
    .then(c => {
      if (c.length) {
        console.log(`OK: ${c.length} свечей, ${new Date(c[0].t).toISOString()} → ${new Date(c[c.length - 1].t).toISOString()}`);
      } else {
        console.log('Данных нет');
      }
    })
    .catch(e => {
      console.error('Ошибка загрузки:', e);
      process.exit(1);
    });
}
