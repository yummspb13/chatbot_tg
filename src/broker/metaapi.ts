// Адаптер MetaTrader 5 через MetaApi.cloud — путь для брокеров без REST API
// (Exness и т.п.; демо-счета MT5 открываются без KYC). Один MT-аккаунт у MetaApi
// бесплатен. Объёмы в лотах: 0.01 лота = 1000 юнитов в нашей терминологии.
//
// Особенности:
// - соединение одно, ленивое; SDK сам переподключается — рестарты стрима котировок
//   движка соединение не пересоздают;
// - имя символа задаётся отдельно (MT5_SYMBOL): у Exness Standard символы
//   с суффиксом «m» (EURUSDm — как XAUUSDm в том самом видео);
// - лимитные входы: ORDER_TIME_SPECIFIED (TTL), исполнение отслеживаем по
//   terminalState (ордер исчез → позиция с тем же тикетом появилась);
// - закрытия TP/SL находим по сделкам historyStorage (DEAL_ENTRY_OUT),
//   pnl = profit + commission + swap.

import { createRequire } from 'node:module';
import {
  AccountState, ClosedPosition, ExecutionAdapter, LimitOrderRequest, OrderCheck,
  OrderRequest, OrderResult, Position, Quote, Side, sleep,
} from './types';

// ESM-сборка metaapi.cloud-sdk собрана под браузер и падает на сервере
// («window is not defined»), поэтому грузим CJS-сборку через createRequire —
// и лениво: в sim/oanda-режимах SDK вообще не загружается.
function loadMetaApiSdk(): any {
  const req = createRequire(import.meta.url);
  const mod = req('metaapi.cloud-sdk');
  return mod?.default ?? mod;
}

export interface MetaApiConfig {
  token: string;
  accountId: string;
  symbol: string; // MT5-имя символа, напр. EURUSD или EURUSDm
  quoteIntervalMs?: number; // дроссель котировок (не задан = сырые тики; live-контур — тики)
}

export class MetaApiAdapter implements ExecutionAdapter {
  readonly name = 'metaapi' as const;
  private api: any;
  private conn: any = null;
  private connecting: Promise<any> | null = null;

  constructor(private cfg: MetaApiConfig) {
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
        await conn.subscribeToMarketData(
          this.cfg.symbol,
          this.cfg.quoteIntervalMs ? [{ type: 'quotes', intervalInMilliseconds: this.cfg.quoteIntervalMs }] : undefined,
        );
        this.conn = conn;
        return conn;
      })().catch(e => {
        this.connecting = null;
        throw e;
      });
    }
    return this.connecting;
  }

  private lots(units: number): number {
    return Math.max(0.01, Math.round((units / 100_000) * 100) / 100);
  }

  private unitsOf(volumeLots: number): number {
    return Math.round((volumeLots ?? 0) * 100_000);
  }

  private deals(): any[] {
    return this.conn?.historyStorage?.deals ?? [];
  }

  private findOpenDeal(positionId: string): any | undefined {
    return this.deals().find(
      (d: any) => String(d.positionId) === positionId && d.entryType === 'DEAL_ENTRY_IN',
    );
  }

  private findCloseDeal(positionId: string): any | undefined {
    const all = this.deals().filter(
      (d: any) => String(d.positionId) === positionId && d.entryType === 'DEAL_ENTRY_OUT',
    );
    return all.length ? all[all.length - 1] : undefined;
  }

  private findPosition(id: string): any | undefined {
    return this.conn?.terminalState?.positions?.find((p: any) => String(p.id) === id);
  }

  async *streamQuotes(_symbol: string, signal: AbortSignal): AsyncGenerator<Quote> {
    const conn = await this.ensure();
    let lastKey = '';
    while (!signal.aborted) {
      await sleep(300, signal);
      if (signal.aborted) break;
      const p = conn.terminalState.price(this.cfg.symbol);
      if (!p || !Number.isFinite(p.bid) || !Number.isFinite(p.ask)) continue;
      const t = p.time ? new Date(p.time) : new Date();
      const key = `${p.bid}|${p.ask}|${t.getTime()}`;
      if (key === lastKey) continue;
      lastKey = key;
      yield { symbol: this.cfg.symbol, bid: p.bid, ask: p.ask, time: t };
    }
  }

  private async waitPosition(id: string, ms: number): Promise<any | null> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const p = this.findPosition(id);
      if (p) return p;
      await sleep(200);
    }
    return null;
  }

  async marketOrder(req: OrderRequest): Promise<OrderResult> {
    const conn = await this.ensure();
    const vol = this.lots(req.units);
    const res = req.side === 'BUY'
      ? await conn.createMarketBuyOrder(this.cfg.symbol, vol, req.slPrice, req.tpPrice)
      : await conn.createMarketSellOrder(this.cfg.symbol, vol, req.slPrice, req.tpPrice);
    const id = String(res.positionId ?? res.orderId);
    const pos = await this.waitPosition(id, 10_000);
    return {
      brokerTradeId: id,
      fillPrice: pos?.openPrice ?? 0,
      filledAt: pos?.time ? new Date(pos.time) : new Date(),
    };
  }

  async limitOrder(req: LimitOrderRequest): Promise<{ orderId: string }> {
    const conn = await this.ensure();
    const vol = this.lots(req.units);
    const opts: Record<string, unknown> = {
      expiration: { type: 'ORDER_TIME_SPECIFIED', time: new Date(Date.now() + req.ttlSec * 1000) },
    };
    const res = req.side === 'BUY'
      ? await conn.createLimitBuyOrder(this.cfg.symbol, vol, req.price, req.slPrice, req.tpPrice, opts)
      : await conn.createLimitSellOrder(this.cfg.symbol, vol, req.price, req.slPrice, req.tpPrice, opts);
    return { orderId: String(res.orderId) };
  }

  async checkOrder(orderId: string): Promise<OrderCheck> {
    const conn = await this.ensure();
    const pending = conn.terminalState.orders?.find((o: any) => String(o.id) === orderId);
    if (pending) return { state: 'PENDING' };
    const pos = this.findPosition(orderId); // в MT5 тикет позиции = тикету исполнившегося ордера
    if (pos) {
      return {
        state: 'FILLED',
        brokerTradeId: orderId,
        fillPrice: pos.openPrice,
        filledAt: pos.time ? new Date(pos.time) : new Date(),
      };
    }
    const openDeal = this.findOpenDeal(orderId); // исполнился и уже успел закрыться
    if (openDeal) {
      return {
        state: 'FILLED',
        brokerTradeId: orderId,
        fillPrice: openDeal.price,
        filledAt: new Date(openDeal.time),
      };
    }
    return { state: 'GONE' };
  }

  async cancelOrder(orderId: string): Promise<void> {
    try {
      const conn = await this.ensure();
      await conn.cancelOrder(orderId);
    } catch {
      // уже исполнен/истёк
    }
  }

  async closePosition(brokerTradeId: string): Promise<ClosedPosition> {
    const conn = await this.ensure();
    const pos = this.findPosition(brokerTradeId);
    await conn.closePosition(brokerTradeId, {});
    let deal: any = null;
    const until = Date.now() + 10_000;
    while (Date.now() < until && !deal) {
      deal = this.findCloseDeal(brokerTradeId);
      if (!deal) await sleep(300);
    }
    const side: Side = pos?.type === 'POSITION_TYPE_SELL' ? 'SELL' : 'BUY';
    return {
      brokerTradeId,
      symbol: this.cfg.symbol,
      side,
      units: this.unitsOf(pos?.volume ?? deal?.volume ?? 0),
      entryPrice: pos?.openPrice ?? 0,
      openedAt: pos?.time ? new Date(pos.time) : new Date(0),
      exitPrice: deal?.price ?? pos?.currentPrice ?? 0,
      closedAt: deal?.time ? new Date(deal.time) : new Date(),
      realizedPnl: deal
        ? (deal.profit ?? 0) + (deal.commission ?? 0) + (deal.swap ?? 0)
        : (pos?.profit ?? 0),
      closeReason: 'MANUAL',
    };
  }

  async closeAll(): Promise<ClosedPosition[]> {
    const conn = await this.ensure();
    const ids: string[] = (conn.terminalState.positions ?? []).map((p: any) => String(p.id));
    const out: ClosedPosition[] = [];
    for (const id of ids) out.push(await this.closePosition(id));
    return out;
  }

  async listPositions(): Promise<Position[]> {
    const conn = await this.ensure();
    return (conn.terminalState.positions ?? []).map((p: any): Position => ({
      brokerTradeId: String(p.id),
      symbol: p.symbol,
      side: p.type === 'POSITION_TYPE_SELL' ? 'SELL' : 'BUY',
      units: this.unitsOf(p.volume),
      entryPrice: p.openPrice,
      slPrice: p.stopLoss,
      tpPrice: p.takeProfit,
      openedAt: p.time ? new Date(p.time) : new Date(0),
      unrealizedPnl: p.profit,
    }));
  }

  async getClosedTrade(brokerTradeId: string): Promise<ClosedPosition | null> {
    await this.ensure();
    const close = this.findCloseDeal(brokerTradeId);
    if (!close) return null;
    const open = this.findOpenDeal(brokerTradeId);
    const reasonMap: Record<string, string> = {
      DEAL_REASON_TP: 'TP',
      DEAL_REASON_SL: 'SL',
    };
    return {
      brokerTradeId,
      symbol: close.symbol ?? this.cfg.symbol,
      side: open?.type === 'DEAL_TYPE_SELL' ? 'SELL' : 'BUY',
      units: this.unitsOf(close.volume ?? 0),
      entryPrice: open?.price ?? 0,
      openedAt: open?.time ? new Date(open.time) : new Date(0),
      exitPrice: close.price,
      closedAt: new Date(close.time),
      realizedPnl: (close.profit ?? 0) + (close.commission ?? 0) + (close.swap ?? 0),
      closeReason: reasonMap[String(close.reason)] ?? 'RECONCILED',
    };
  }

  async accountState(): Promise<AccountState> {
    const conn = await this.ensure();
    const a = conn.terminalState.accountInformation ?? {};
    return {
      currency: a.currency ?? 'USD',
      balance: a.balance ?? 0,
      equity: a.equity ?? a.balance ?? 0,
      openPositionCount: (conn.terminalState.positions ?? []).length,
    };
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
