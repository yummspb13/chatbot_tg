// HTTP-клиент Polymarket: gamma (метаданные рынков) + CLOB (стаканы).
// Всё read-only, без ключей. Два жёстких правила из живой разведки 17.08:
// 1) clob.polymarket.com за Cloudflare — БЕЗ браузерного User-Agent отдаёт 403;
// 2) undici не читает HTTPS_PROXY сам — в дев-контейнере ходим через ProxyAgent,
//    на Render напрямую (паттерн triangles.ts; CA-пин не нужен — цепочка обычная).
//
// Бюджет запросов — священен (два сожжённых лимита Render): у клиента свой
// счётчик counters(), самокап обеспечивает коллектор.
//
// CLI-смоук: npx tsx src/poly/client.ts — слаги/книги/фи текущих бакетов
// по активам из POLY_ASSETS + разовая проверка, какие активы вообще существуют.

import { pathToFileURL } from 'node:url';
import { Agent, Dispatcher, ProxyAgent, request } from 'undici';
import { errMsg, log } from '../logger';
import { sleep } from '../broker/types';

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

export interface GammaMarket {
  question: string;
  slug: string;
  endDate: string;          // ISO
  closed: boolean;
  outcomes: string;         // JSON-строка вида '["Up","Down"]'
  outcomePrices: string;    // JSON-строка вида '["0.505","0.495"]'
  bestBid?: number;
  bestAsk?: number;
  clobTokenIds: string;     // JSON-строка массива из 2 токенов [UP, DOWN]
  feeSchedule?: { exponent: number; rate: number; takerOnly: boolean; rebateRate: number };
  cryptoMarketConfig?: { id: string; asset: string; duration: string; twapEnabled: boolean; twapLookbackSeconds: number };
}

export interface BookLevel {
  price: string;
  size: string;
}

export interface Book {
  bids: BookLevel[];
  asks: BookLevel[];
  tick_size: string;
  min_order_size: string;
  last_trade_price?: string;
}

/** Тейкер-фи crypto_fees_v2: rate × min(p, 1−p)^exponent × shares.
 *  Константы ТОЛЬКО из живого feeSchedule рынка — не хардкодим. */
export function takerFeeUsd(price: number, shares: number, fee?: GammaMarket['feeSchedule']): number {
  if (!fee || !fee.rate) return 0;
  return fee.rate * Math.min(price, 1 - price) ** (fee.exponent || 1) * shares;
}

export class PolyClient {
  private dispatcher: Dispatcher;
  private stats = { gamma: 0, book: 0, errors: 0, cf403: 0, windowStart: Date.now(), windowReqs: 0 };

  constructor() {
    const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
    this.dispatcher = proxy ? new ProxyAgent({ uri: proxy }) : new Agent();
  }

  private async get<T>(url: string): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      this.bumpWindow();
      const res = await request(url, {
        dispatcher: this.dispatcher,
        headers: { 'user-agent': UA, accept: 'application/json' },
        headersTimeout: 15_000,
        bodyTimeout: 15_000,
      });
      const text = await res.body.text();
      if (res.statusCode === 403) this.stats.cf403 += 1;
      if ((res.statusCode === 429 || res.statusCode >= 500) && attempt < 3) {
        await sleep(2000 * 2 ** attempt);
        continue;
      }
      if (res.statusCode !== 200) {
        this.stats.errors += 1;
        throw new Error(`poly GET ${url.slice(0, 80)}: HTTP ${res.statusCode} ${text.slice(0, 100)}`);
      }
      return JSON.parse(text) as T;
    }
  }

  private bumpWindow(): void {
    const now = Date.now();
    if (now - this.stats.windowStart > 60_000) {
      this.stats.windowStart = now;
      this.stats.windowReqs = 0;
    }
    this.stats.windowReqs += 1;
  }

  /** Рынок события по слагу (events API даёт вложенный markets[0]). */
  async marketBySlug(slug: string): Promise<GammaMarket | null> {
    this.stats.gamma += 1;
    const evs = await this.get<Array<{ markets?: GammaMarket[] }>>(`${GAMMA}/events?slug=${encodeURIComponent(slug)}`);
    return evs?.[0]?.markets?.[0] ?? null;
  }

  /** Листинг активных crypto-событий — фолбэк дискавери и проверка покрытия активов. */
  async activeCryptoEvents(limit = 40): Promise<string[]> {
    this.stats.gamma += 1;
    const evs = await this.get<Array<{ slug?: string }>>(
      `${GAMMA}/events?limit=${limit}&active=true&closed=false&tag_slug=crypto&order=startDate&ascending=false`,
    );
    return (evs ?? []).map(e => e.slug ?? '').filter(Boolean);
  }

  /** Закрытые рынки (харвестер истории, M4). */
  async marketsClosed(params: { limit: number; offset: number }): Promise<GammaMarket[]> {
    this.stats.gamma += 1;
    return this.get<GammaMarket[]>(
      `${GAMMA}/markets?closed=true&limit=${params.limit}&offset=${params.offset}&order=endDate&ascending=false&tag_slug=crypto`,
    );
  }

  /** Верх и глубина стакана токена. */
  async book(tokenId: string): Promise<Book> {
    this.stats.book += 1;
    return this.get<Book>(`${CLOB}/book?token_id=${tokenId}`);
  }

  counters() {
    return {
      gamma: this.stats.gamma,
      book: this.stats.book,
      errors: this.stats.errors,
      cf403: this.stats.cf403,
      perMin: this.stats.windowReqs,
    };
  }

  async shutdown(): Promise<void> {
    await this.dispatcher.close().catch(() => {});
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  (async () => {
    const { bucketStart, slugFor, resolveCurrent } = await import('./markets');
    const client = new PolyClient();
    const assets = (process.env.POLY_ASSETS || 'btc,eth').split(',');

    console.log('=== проверка покрытия активов (разовая) ===');
    for (const a of ['btc', 'eth', 'sol', 'bnb', 'hype', 'xrp', 'doge']) {
      const slug = slugFor(a, bucketStart(Date.now()));
      const m = await client.marketBySlug(slug).catch(e => (console.log(`  ${a}: ошибка ${errMsg(e)}`), null));
      console.log(`  ${a}: ${m ? `ЕСТЬ (${m.question})` : 'нет'}`);
    }

    for (const asset of assets) {
      console.log(`\n=== ${asset} ===`);
      const ref = await resolveCurrent(client, asset);
      if (!ref) {
        console.log('  текущий бакет не найден');
        continue;
      }
      console.log(`  слаг: ${ref.slug} · конец: ${new Date(ref.endDateMs).toISOString()} · tick ${ref.tickSize} · minOrder ${ref.minOrderSize}`);
      console.log(`  fee: ${JSON.stringify(ref.feeSchedule)}`);
      const [up, down] = await Promise.all([client.book(ref.upTokenId), client.book(ref.downTokenId)]);
      const top = (b: Book, side: 'bids' | 'asks') => b[side].length ? b[side][b[side].length - 1] : null;
      const upAsk = top(up, 'asks');
      const downAsk = top(down, 'asks');
      console.log(`  UP:   bid ${JSON.stringify(top(up, 'bids'))} · ask ${JSON.stringify(upAsk)}`);
      console.log(`  DOWN: bid ${JSON.stringify(top(down, 'bids'))} · ask ${JSON.stringify(downAsk)}`);
      if (upAsk && downAsk) {
        const sum = Number(upAsk.price) + Number(downAsk.price);
        console.log(`  setSumAsk = ${sum.toFixed(3)} ${sum < 1 ? '← ОКНО!' : ''}`);
      }
      console.log(`  фи-проверка: takerFeeUsd(0.5, 100) = ${takerFeeUsd(0.5, 100, ref.feeSchedule).toFixed(2)}$`);
    }
    const next = bucketStart(Date.now()) + 300;
    console.log(`\nследующий бакет btc: ${slugFor('btc', next)} (детерминирован)`);
    console.log('счётчики:', client.counters());
    await client.shutdown();
    process.exit(0);
  })().catch(e => {
    console.error(e);
    process.exit(1);
  });
}
