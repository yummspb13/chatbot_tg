// Коллектор Polymarket 5-минуток: стаканы обеих сторон активных рынков + учёт
// резолюций. Read-only, паттерн moexleg.loop. Трафик-самокап 30 req/мин
// (священен после двух сожжённых лимитов Render): при превышении тик
// пропускается целиком.
//
// Запись в БД разреженная: базовый снап 1/мин/актив + событийные каждый тик,
// пока setSumAsk < 1.005 (кап 720 событийных/час — защита от шторма).
//
// CLI-смоук: npx tsx src/poly/collector.ts — 3 минуты на MemoryStore.

import { pathToFileURL } from 'node:url';
import { errMsg, log } from '../logger';
import { sleep } from '../broker/types';
import { Book, PolyClient } from './client';
import { BUCKET_SEC, bucketStart, parseRef, PolyMarketRef, slugFor } from './markets';
import { createPolyStore, PolyStore } from './store';

const TICK_MS = 10_000;
const REQ_CAP_PER_MIN = 30;
const EVENT_THRESHOLD = 1.005;
const EVENT_CAP_PER_HOUR = 720;

export interface TopOfBook {
  asset: string;
  slug: string;
  endDateMs: number;
  upBid: number | null;
  upAsk: number | null;
  upAskSize: number;
  downBid: number | null;
  downAsk: number | null;
  downAskSize: number;
  setSumAsk: number | null;
  depthUsd: number | null;
  refPx: number | null;
  feeSchedule?: PolyMarketRef['feeSchedule'];
  time: Date;
}

export interface PolyCollectorDeps {
  store: PolyStore;
  notify: (text: string) => Promise<void>;
  getRefPrice?: (asset: string) => number | null;
}

function top(b: Book, side: 'bids' | 'asks'): { price: number; size: number } | null {
  const lvl = b[side].length ? b[side][b[side].length - 1] : null;
  return lvl ? { price: Number(lvl.price), size: Number(lvl.size) } : null;
}

export class PolyCollector {
  private client = new PolyClient();
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private markets = new Map<string, PolyMarketRef>(); // asset → текущий рынок
  private lastBaseSnapAt = new Map<string, number>();
  private lastPollAt = 0;
  private eventWindow: number[] = []; // ts событийных снапов за час
  private errStreak = 0;
  private cf403Streak = 0;
  private pendingResolutions = new Map<string, { asset: string; endMs: number; tries: number }>();
  private lastResReqAt = 0;
  private lastTop = new Map<string, TopOfBook>();
  private topListeners: Array<(t: TopOfBook) => void> = [];
  private windowsToday = 0;
  private windowsDayKey = '';
  private cachedSummary: Awaited<ReturnType<PolyCollector['summary']>> | null = null;
  private lastSummaryAt = 0;

  constructor(private deps: PolyCollectorDeps, private assets: string[]) {}

  onTop(cb: (t: TopOfBook) => void): void {
    this.topListeners.push(cb);
  }

  isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.loopPromise = this.loop();
    log.success(
      `Polymarket-коллектор запущен: ${this.assets.join('/')} 5m — read-only, тик ${TICK_MS / 1000}с, самокап ${REQ_CAP_PER_MIN} req/мин`,
      undefined, 'poly',
    );
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    await this.loopPromise?.catch(() => {});
    this.loopPromise = null;
    await this.client.shutdown();
    log.info('Polymarket-коллектор остановлен', undefined, 'poly');
  }

  private async loop(): Promise<void> {
    while (this.running) {
      const tickStart = Date.now();
      try {
        if (this.client.counters().perMin >= REQ_CAP_PER_MIN) {
          log.warn(`poly: самокап ${REQ_CAP_PER_MIN} req/мин — тик пропущен`, undefined, 'poly');
        } else {
          for (const asset of this.assets) {
            if (!this.running) break;
            await this.pollAsset(asset);
          }
          await this.pollResolutions();
        }
        this.errStreak = 0;
        if (Date.now() - this.lastSummaryAt > 60_000) {
          this.lastSummaryAt = Date.now();
          this.cachedSummary = await this.summary();
        }
      } catch (e) {
        this.errStreak += 1;
        if (this.errStreak % 20 === 1) log.warn(`poly-коллектор: ${errMsg(e)}`, undefined, 'poly');
      }
      const spent = Date.now() - tickStart;
      await sleep(Math.max(1000, TICK_MS - spent));
    }
  }

  /** Текущий рынок актива: смена бакета/истечение → резолв нового; префетч
   *  следующего за 60с до конца (гонка на границе бакета). */
  private async ensureMarket(asset: string): Promise<PolyMarketRef | null> {
    const now = Date.now();
    const cur = this.markets.get(asset);
    if (cur && cur.endDateMs > now) {
      if (cur.endDateMs - now < 60_000) {
        const nextSlug = slugFor(asset, bucketStart(now) + BUCKET_SEC);
        if (!this.markets.has(`next:${asset}`)) {
          const m = await this.client.marketBySlug(nextSlug).catch(() => null);
          const ref = m ? parseRef(asset, m) : null;
          if (ref) this.markets.set(`next:${asset}`, ref);
        }
      }
      return cur;
    }
    if (cur) {
      // рынок истёк — в очередь на резолюцию
      this.pendingResolutions.set(cur.slug, { asset, endMs: cur.endDateMs, tries: 0 });
      this.markets.delete(asset);
    }
    const prefetched = this.markets.get(`next:${asset}`);
    if (prefetched && prefetched.endDateMs > now) {
      this.markets.delete(`next:${asset}`);
      this.markets.set(asset, prefetched);
      return prefetched;
    }
    const slug = slugFor(asset, bucketStart(now));
    const m = await this.client.marketBySlug(slug).catch(e => {
      if (String(errMsg(e)).includes('403')) this.cf403Streak += 1;
      return null;
    });
    const ref = m && !m.closed ? parseRef(asset, m) : null;
    if (ref) {
      this.markets.set(asset, ref);
      return ref;
    }
    return null; // бакет без рынка — честно пропускаем
  }

  private async pollAsset(asset: string): Promise<void> {
    const ref = await this.ensureMarket(asset);
    if (!ref) return;
    const [upBook, downBook] = [await this.client.book(ref.upTokenId), await this.client.book(ref.downTokenId)];
    this.lastPollAt = Date.now();
    this.cf403Streak = 0;
    const upAsk = top(upBook, 'asks');
    const upBid = top(upBook, 'bids');
    const downAsk = top(downBook, 'asks');
    const downBid = top(downBook, 'bids');
    // пустая книга → null-поля, событие не взводится
    const setSumAsk = upAsk && downAsk ? +(upAsk.price + downAsk.price).toFixed(4) : null;
    const depthUsd = upAsk && downAsk && setSumAsk
      ? +(Math.min(upAsk.size, downAsk.size) * setSumAsk).toFixed(2)
      : null;
    const t: TopOfBook = {
      asset, slug: ref.slug, endDateMs: ref.endDateMs,
      upBid: upBid?.price ?? null, upAsk: upAsk?.price ?? null, upAskSize: upAsk?.size ?? 0,
      downBid: downBid?.price ?? null, downAsk: downAsk?.price ?? null, downAskSize: downAsk?.size ?? 0,
      setSumAsk, depthUsd,
      refPx: this.deps.getRefPrice?.(asset) ?? null,
      feeSchedule: ref.feeSchedule,
      time: new Date(),
    };
    this.lastTop.set(asset, t);
    for (const cb of this.topListeners) {
      try {
        cb(t);
      } catch (e) {
        log.warn(`poly onTop-слушатель: ${errMsg(e)}`, undefined, 'poly');
      }
    }

    const isWindow = setSumAsk !== null && setSumAsk < EVENT_THRESHOLD;
    const dayKey = t.time.toISOString().slice(0, 10);
    if (dayKey !== this.windowsDayKey) {
      this.windowsDayKey = dayKey;
      this.windowsToday = 0;
    }
    const nowMs = Date.now();
    this.eventWindow = this.eventWindow.filter(x => nowMs - x < 3600_000);
    const baseDue = nowMs - (this.lastBaseSnapAt.get(asset) ?? 0) >= 60_000;
    const eventAllowed = isWindow && this.eventWindow.length < EVENT_CAP_PER_HOUR;
    if (baseDue || eventAllowed) {
      if (eventAllowed) {
        this.eventWindow.push(nowMs);
        if (setSumAsk !== null && setSumAsk < 1) this.windowsToday += 1;
      }
      if (baseDue) this.lastBaseSnapAt.set(asset, nowMs);
      await this.deps.store.saveSnap({
        asset, slug: ref.slug, endDate: new Date(ref.endDateMs),
        upBid: t.upBid, upAsk: t.upAsk, downBid: t.downBid, downAsk: t.downAsk,
        setSumAsk, depthUsd, refPx: t.refPx, isEvent: eventAllowed,
      });
    }
  }

  /** Резолюции истёкших рынков: gamma по слагу через 120с после endDate.
   *  Бюджет жёсткий: ≤1 HTTP-запрос за вызов и не чаще раза в 20с (3 req/мин),
   *  иначе на смене бакета минутный бюджет 24 (книги) + резолюции пробивает
   *  самокап 30. Старый код с `continue` слал запрос на КАЖДУЮ ожидающую
   *  запись за тик — это и был бурст, вставший дедлоком 17.08 (8ч простоя). */
  private async pollResolutions(): Promise<void> {
    const now = Date.now();
    // предохранитель: очередь не растёт бесконечно, старейшие — под нож
    while (this.pendingResolutions.size > 24) {
      const oldest = this.pendingResolutions.keys().next().value as string;
      this.pendingResolutions.delete(oldest);
      log.warn(`poly: очередь резолюций >24 — выбрасываю ${oldest} (добёрет харвестер M4)`, undefined, 'poly');
    }
    if (now - this.lastResReqAt < 20_000) return;
    for (const [slug, p] of this.pendingResolutions) {
      if (now - p.endMs < 120_000) continue;
      if (p.tries > 15) {
        this.pendingResolutions.delete(slug);
        log.warn(`poly: резолюция ${slug} не получена за ${p.tries} попыток — сдаюсь`, undefined, 'poly');
        continue;
      }
      if (await this.deps.store.hasResolution(slug)) {
        this.pendingResolutions.delete(slug);
        continue;
      }
      p.tries += 1;
      this.lastResReqAt = now;
      const m = await this.client.marketBySlug(slug).catch(() => null);
      if (m && m.closed) {
        try {
          const prices = JSON.parse(m.outcomePrices) as string[];
          const upPrice = Number(prices[0]);
          const outcome: 'up' | 'down' = upPrice > 0.5 ? 'up' : 'down';
          await this.deps.store.saveResolution({
            slug, asset: p.asset, endTs: new Date(p.endMs), outcome, closeUpPrice: upPrice,
          });
          this.pendingResolutions.delete(slug);
        } catch (e) {
          log.warn(`poly: разбор резолюции ${slug}: ${errMsg(e)}`, undefined, 'poly');
        }
      }
      break; // ровно один HTTP-запрос резолюций за вызов
    }
  }

  /** Синхронная версия для engine.status()/health — кэш минутной давности. */
  summarySync() {
    return this.cachedSummary ?? { enabled: true, running: this.running, assets: this.assets, lastPollAgoSec: null };
  }

  async summary() {
    const counters = this.client.counters();
    const counts = await this.deps.store.countsToday().catch(() => ({ snaps: -1, events: -1, resolutions: -1 }));
    return {
      enabled: true,
      running: this.running,
      assets: this.assets,
      lastPollAgoSec: this.lastPollAt ? Math.round((Date.now() - this.lastPollAt) / 1000) : null,
      reqPerMin: counters.perMin,
      cf403: counters.cf403,
      errors: counters.errors,
      snapsToday: counts.snaps,
      eventsToday: counts.events,
      resolutionsToday: counts.resolutions,
      windowsToday: this.windowsToday,
      perAsset: [...this.lastTop.values()].map(t => ({
        asset: t.asset,
        slug: t.slug,
        endDateMs: t.endDateMs, // клиент экрана тикает secToEnd сам между поллами
        secToEnd: Math.max(0, Math.round((t.endDateMs - Date.now()) / 1000)),
        upBid: t.upBid, upAsk: t.upAsk, downBid: t.downBid, downAsk: t.downAsk,
        setSumAsk: t.setSumAsk,
        depthUsd: t.depthUsd,
        refPx: t.refPx,
        ageSec: Math.round((Date.now() - t.time.getTime()) / 1000),
      })),
    };
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  (async () => {
    const store = createPolyStore();
    const collector = new PolyCollector(
      { store, notify: async t => console.log('NOTIFY:', t) },
      (process.env.POLY_ASSETS || 'btc,eth').split(','),
    );
    collector.onTop(t => console.log(
      `top ${t.asset}: up ${t.upBid}/${t.upAsk} · down ${t.downBid}/${t.downAsk} · sum ${t.setSumAsk} · depth $${t.depthUsd} · до конца ${Math.round((t.endDateMs - Date.now()) / 1000)}с`,
    ));
    await collector.start();
    await new Promise(r => setTimeout(r, 180_000));
    console.log('\nsummary:', JSON.stringify(await collector.summary(), null, 1));
    await collector.stop();
    process.exit(0);
  })().catch(e => {
    console.error(e);
    process.exit(1);
  });
}
