// Математика 5-минутных бакетов Polymarket и резолв текущего рынка.
// Слаг детерминирован: `<asset>-updown-5m-<unix начала бакета>` (шаг 300с,
// проверено живьём 17.08: btc-updown-5m-1787088300). ET-строки из question
// НИКОГДА не парсим — только unix-слаг и endDate.

import { GammaMarket, PolyClient } from './client';

export const BUCKET_SEC = 300;

/** Unix-секунды начала бакета, в котором лежит момент tsMs. */
export function bucketStart(tsMs: number, stepSec = BUCKET_SEC): number {
  return Math.floor(tsMs / 1000 / stepSec) * stepSec;
}

export function slugFor(asset: string, bucketUnix: number): string {
  return `${asset}-updown-5m-${bucketUnix}`;
}

export interface PolyMarketRef {
  asset: string;
  slug: string;
  endDateMs: number;
  upTokenId: string;
  downTokenId: string;
  tickSize: string;
  minOrderSize: string;
  feeSchedule?: GammaMarket['feeSchedule'];
  raw: GammaMarket;
}

const refCache = new Map<string, PolyMarketRef | null>();

export function parseRef(asset: string, m: GammaMarket): PolyMarketRef | null {
  try {
    const tokens = JSON.parse(m.clobTokenIds) as string[];
    if (!Array.isArray(tokens) || tokens.length !== 2) return null;
    return {
      asset,
      slug: m.slug,
      endDateMs: new Date(m.endDate).getTime(),
      upTokenId: tokens[0],
      downTokenId: tokens[1],
      tickSize: (m as any).orderPriceMinTickSize ?? '0.01',
      minOrderSize: (m as any).orderMinSize ?? '5',
      feeSchedule: m.feeSchedule,
      raw: m,
    };
  } catch {
    return null;
  }
}

/** Рынок текущего бакета актива; кэш по слагу (бакет резолвится один раз). */
export async function resolveCurrent(client: PolyClient, asset: string): Promise<PolyMarketRef | null> {
  const slug = slugFor(asset, bucketStart(Date.now()));
  if (refCache.has(slug)) return refCache.get(slug) ?? null;
  const m = await client.marketBySlug(slug);
  const ref = m ? parseRef(asset, m) : null;
  refCache.set(slug, ref);
  if (refCache.size > 300) {
    const oldest = refCache.keys().next().value;
    if (oldest !== undefined) refCache.delete(oldest);
  }
  return ref;
}
