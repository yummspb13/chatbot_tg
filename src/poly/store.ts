// Хранилище Polymarket-подсистемы: снапы стаканов и резолюции 5-минуток.
// Отдельный интерфейс (TradeStore не расширяем — он про сделки). Prisma при
// DATABASE_URL, иначе Memory-фолбэк для локальных смоуков (кольцо ≤5000).
// Бумажные СДЕЛКИ мейкера сюда не пишутся — они идут в agent_Trade через
// TradeStore (mode='virtual', symbol='POLY_<ASSET>5M~<member>').
//
// CLI-смоук: npx tsx src/poly/store.ts — круговая запись/чтение/удаление.

import { pathToFileURL } from 'node:url';
import { log } from '../logger';

export interface PolySnapInput {
  asset: string;
  slug: string;
  endDate: Date;
  upBid: number | null;
  upAsk: number | null;
  downBid: number | null;
  downAsk: number | null;
  setSumAsk: number | null;
  depthUsd: number | null;
  refPx: number | null;
  isEvent: boolean;
}

export interface PolySnapRow extends PolySnapInput {
  id: number;
  ts: Date;
}

export interface PolyResolutionInput {
  slug: string;
  asset: string;
  endTs: Date;
  outcome: 'up' | 'down';
  closeUpPrice: number | null;
  twapNote?: string | null;
}

export interface PolyStore {
  readonly persistent: boolean;
  saveSnap(s: PolySnapInput): Promise<void>;
  saveResolution(r: PolyResolutionInput): Promise<void>; // upsert по slug — идемпотентно
  snaps(hours: number, asset?: string): Promise<PolySnapRow[]>;
  resolutions(limit: number, asset?: string): Promise<Array<PolyResolutionInput & { id: number }>>;
  hasResolution(slug: string): Promise<boolean>;
  countsToday(): Promise<{ snaps: number; events: number; resolutions: number }>;
}

class PrismaPolyStore implements PolyStore {
  readonly persistent = true;

  private async p() {
    const { getPrisma } = await import('../db');
    return getPrisma();
  }

  async saveSnap(s: PolySnapInput): Promise<void> {
    const p = await this.p();
    await p.polySnap.create({ data: s });
  }

  async saveResolution(r: PolyResolutionInput): Promise<void> {
    const p = await this.p();
    await p.polyResolution.upsert({
      where: { slug: r.slug },
      create: r,
      update: { outcome: r.outcome, closeUpPrice: r.closeUpPrice, twapNote: r.twapNote ?? null },
    });
  }

  async snaps(hours: number, asset?: string): Promise<PolySnapRow[]> {
    const p = await this.p();
    return p.polySnap.findMany({
      where: { ts: { gte: new Date(Date.now() - hours * 3600_000) }, ...(asset ? { asset } : {}) },
      orderBy: { ts: 'asc' },
      take: 20_000,
    });
  }

  async resolutions(limit: number, asset?: string) {
    const p = await this.p();
    return p.polyResolution.findMany({
      where: asset ? { asset } : undefined,
      orderBy: { endTs: 'desc' },
      take: limit,
    }) as any;
  }

  async hasResolution(slug: string): Promise<boolean> {
    const p = await this.p();
    return (await p.polyResolution.count({ where: { slug } })) > 0;
  }

  async countsToday() {
    const p = await this.p();
    const since = new Date(new Date().toISOString().slice(0, 10));
    const [snaps, events, resolutions] = await Promise.all([
      p.polySnap.count({ where: { ts: { gte: since } } }),
      p.polySnap.count({ where: { ts: { gte: since }, isEvent: true } }),
      p.polyResolution.count({ where: { createdAt: { gte: since } } }),
    ]);
    return { snaps, events, resolutions };
  }
}

class MemoryPolyStore implements PolyStore {
  readonly persistent = false;
  private snapRows: PolySnapRow[] = [];
  private resRows: Array<PolyResolutionInput & { id: number; createdAt: Date }> = [];
  private nextId = 1;

  async saveSnap(s: PolySnapInput): Promise<void> {
    this.snapRows.push({ ...s, id: this.nextId++, ts: new Date() });
    if (this.snapRows.length > 5000) this.snapRows.shift();
  }

  async saveResolution(r: PolyResolutionInput): Promise<void> {
    const ex = this.resRows.find(x => x.slug === r.slug);
    if (ex) Object.assign(ex, r);
    else this.resRows.push({ ...r, id: this.nextId++, createdAt: new Date() });
  }

  async snaps(hours: number, asset?: string): Promise<PolySnapRow[]> {
    const since = Date.now() - hours * 3600_000;
    return this.snapRows.filter(s => s.ts.getTime() >= since && (!asset || s.asset === asset));
  }

  async resolutions(limit: number, asset?: string) {
    return this.resRows.filter(r => !asset || r.asset === asset).slice(-limit).reverse();
  }

  async hasResolution(slug: string): Promise<boolean> {
    return this.resRows.some(r => r.slug === slug);
  }

  async countsToday() {
    const since = new Date(new Date().toISOString().slice(0, 10)).getTime();
    return {
      snaps: this.snapRows.filter(s => s.ts.getTime() >= since).length,
      events: this.snapRows.filter(s => s.ts.getTime() >= since && s.isEvent).length,
      resolutions: this.resRows.filter(r => r.createdAt.getTime() >= since).length,
    };
  }
}

export function createPolyStore(): PolyStore {
  if (process.env.DATABASE_URL) return new PrismaPolyStore();
  log.warn('DATABASE_URL не задан — PolyStore в памяти (только смоук)', undefined, 'poly');
  return new MemoryPolyStore();
}

// Общий инстанс процесса: коллектор (engine) пишет, /api/poly/* (экран) читает.
// Важно для Memory-фолбэка — два createPolyStore() не увидели бы данных друг друга.
let shared: PolyStore | null = null;
export function polyStore(): PolyStore {
  shared ??= createPolyStore();
  return shared;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  (async () => {
    const store = createPolyStore();
    console.log('persistent:', store.persistent);
    await store.saveSnap({
      asset: 'smoke', slug: 'smoke-updown-5m-0', endDate: new Date(),
      upBid: 0.5, upAsk: 0.52, downBid: 0.47, downAsk: 0.49,
      setSumAsk: 1.01, depthUsd: 100, refPx: 64000, isEvent: false,
    });
    await store.saveResolution({ slug: 'smoke-updown-5m-0', asset: 'smoke', endTs: new Date(), outcome: 'up', closeUpPrice: 1 });
    await store.saveResolution({ slug: 'smoke-updown-5m-0', asset: 'smoke', endTs: new Date(), outcome: 'down', closeUpPrice: 0 }); // upsert
    const snaps = await store.snaps(1, 'smoke');
    const res = await store.resolutions(5, 'smoke');
    console.log('снапов:', snaps.length, '· резолюция:', res[0]?.outcome, '(должна быть down после upsert)');
    console.log('счётчики дня:', await store.countsToday());
    if (store.persistent) {
      const { getPrisma } = await import('../db');
      const p = getPrisma();
      await p.polySnap.deleteMany({ where: { asset: 'smoke' } });
      await p.polyResolution.deleteMany({ where: { asset: 'smoke' } });
      console.log('smoke-строки удалены');
    }
    process.exit(0);
  })().catch(e => {
    console.error(e);
    process.exit(1);
  });
}
