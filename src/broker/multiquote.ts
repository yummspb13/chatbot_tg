// Мультирыночный котировочный фид для виртуальной ноги портфеля.
//
// Одно streaming-соединение MetaApi подписывается сразу на несколько MT5-символов
// (золото, нефть, GBPJPY, S&P500) и раздаёт их сырые bid/ask одним async-потоком.
// Ордеров фид не отправляет вообще — он существует только для виртуальных книг
// ансамбля. Масштабирование цен (priceScale) делает получатель.

import { createRequire } from 'node:module';
import { sleep } from './types';

// ESM-сборка metaapi.cloud-sdk собрана под браузер и падает на сервере
// («window is not defined») — грузим CJS-сборку, как в metaapi.ts.
function loadMetaApiSdk(): any {
  const req = createRequire(import.meta.url);
  const mod = req('metaapi.cloud-sdk');
  return mod?.default ?? mod;
}

export interface MultiQuote {
  mt5Symbol: string;
  bid: number;
  ask: number;
  time: Date;
}

export class MultiQuoteFeed {
  private api: any;
  private conn: any = null;
  private connecting: Promise<any> | null = null;

  constructor(private cfg: { token: string; accountId: string; symbols: string[] }) {
    const MetaApi = loadMetaApiSdk();
    this.api = new MetaApi(cfg.token, { requestTimeout: 60_000 });
  }

  private async ensure(): Promise<any> {
    if (this.conn) return this.conn;
    if (!this.connecting) {
      this.connecting = (async () => {
        const account = await this.api.metatraderAccountApi.getAccount(this.cfg.accountId);
        if (account.state !== 'DEPLOYED') await account.deploy();
        await account.waitConnected();
        const conn = account.getStreamingConnection();
        await conn.connect();
        await conn.waitSynchronized({ timeoutInSeconds: 180 });
        for (const s of this.cfg.symbols) await conn.subscribeToMarketData(s);
        this.conn = conn;
        return conn;
      })().catch(e => {
        this.connecting = null;
        throw e;
      });
    }
    return this.connecting;
  }

  /** Котировки всех символов одним потоком: обход раз в 500мс, дедуп по символу.
   *  На сессионных перерывах (ночь/выходные) символ просто молчит. */
  async *stream(signal: AbortSignal): AsyncGenerator<MultiQuote> {
    const conn = await this.ensure();
    const lastKey = new Map<string, string>();
    while (!signal.aborted) {
      await sleep(500, signal);
      if (signal.aborted) break;
      for (const s of this.cfg.symbols) {
        const p = conn.terminalState.price(s);
        if (!p || !Number.isFinite(p.bid) || !Number.isFinite(p.ask)) continue;
        const t = p.time ? new Date(p.time) : new Date();
        const key = `${p.bid}|${p.ask}|${t.getTime()}`;
        if (lastKey.get(s) === key) continue;
        lastKey.set(s, key);
        yield { mt5Symbol: s, bid: p.bid, ask: p.ask, time: t };
      }
    }
  }

  async shutdown(): Promise<void> {
    const conn = this.conn;
    this.conn = null;
    this.connecting = null;
    if (conn) {
      try {
        await conn.close();
      } catch {
        // сокет уже закрыт
      }
    }
  }
}
