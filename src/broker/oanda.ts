// OANDA v20: practice и live — один и тот же API, различаются только хосты и токен.
// Котировки — HTTP-стрим NDJSON (PRICE/HEARTBEAT), ордера — REST, SL/TP на стороне брокера.

import { request } from 'undici';
import {
  AccountState, ClosedPosition, ExecutionAdapter, LimitOrderRequest, OrderCheck,
  OrderRequest, OrderResult, Position, Quote, Side,
} from './types';

export interface OandaConfig {
  env: 'practice' | 'live';
  token: string;
  accountId: string;
}

export class OandaAdapter implements ExecutionAdapter {
  readonly name = 'oanda' as const;
  private restHost: string;
  private streamHost: string;

  constructor(private cfg: OandaConfig) {
    this.restHost = cfg.env === 'live' ? 'https://api-fxtrade.oanda.com' : 'https://api-fxpractice.oanda.com';
    this.streamHost = cfg.env === 'live' ? 'https://stream-fxtrade.oanda.com' : 'https://stream-fxpractice.oanda.com';
  }

  private get headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.cfg.token}`,
      'content-type': 'application/json',
      'accept-datetime-format': 'RFC3339',
    };
  }

  private async rest<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<T> {
    const res = await request(`${this.restHost}${path}`, {
      method,
      headers: this.headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      headersTimeout: 15_000,
      bodyTimeout: 15_000,
    });
    const text = await res.body.text();
    if (res.statusCode >= 300) {
      throw new Error(`OANDA ${method} ${path} → ${res.statusCode}: ${text.slice(0, 400)}`);
    }
    return JSON.parse(text) as T;
  }

  async *streamQuotes(symbol: string, signal: AbortSignal): AsyncGenerator<Quote> {
    const url = `${this.streamHost}/v3/accounts/${this.cfg.accountId}/pricing/stream?instruments=${encodeURIComponent(symbol)}`;
    // heartbeat каждые ~5 c; bodyTimeout 30 c ловит «мёртвый» коннект между чанками
    const res = await request(url, {
      method: 'GET',
      headers: this.headers,
      signal,
      headersTimeout: 15_000,
      bodyTimeout: 30_000,
    });
    if (res.statusCode >= 300) {
      const t = await res.body.text();
      throw new Error(`OANDA stream → ${res.statusCode}: ${t.slice(0, 300)}`);
    }
    let buf = '';
    for await (const chunk of res.body) {
      buf += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg: any;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.type === 'PRICE' && msg.bids?.length && msg.asks?.length) {
          yield {
            symbol,
            bid: parseFloat(msg.bids[0].price),
            ask: parseFloat(msg.asks[0].price),
            time: new Date(msg.time),
          };
        }
        // HEARTBEAT просто держит соединение живым
      }
    }
  }

  async marketOrder(req: OrderRequest): Promise<OrderResult> {
    const units = req.side === 'BUY' ? req.units : -req.units;
    const order: Record<string, unknown> = {
      type: 'MARKET',
      instrument: req.symbol,
      units: String(units),
      timeInForce: 'FOK',
      positionFill: 'DEFAULT',
    };
    if (req.slPrice !== undefined) order.stopLossOnFill = { price: req.slPrice.toFixed(5) };
    if (req.tpPrice !== undefined) order.takeProfitOnFill = { price: req.tpPrice.toFixed(5) };

    const data = await this.rest<any>('POST', `/v3/accounts/${this.cfg.accountId}/orders`, { order });
    const fill = data.orderFillTransaction;
    if (!fill) {
      const reason = data.orderCancelTransaction?.reason ?? JSON.stringify(data).slice(0, 300);
      throw new Error(`OANDA: ордер не исполнен (${reason})`);
    }
    return {
      brokerTradeId: String(fill.tradeOpened?.tradeID ?? fill.id),
      fillPrice: parseFloat(fill.price),
      filledAt: new Date(fill.time),
    };
  }

  async closePosition(brokerTradeId: string): Promise<ClosedPosition> {
    const data = await this.rest<any>('PUT', `/v3/accounts/${this.cfg.accountId}/trades/${brokerTradeId}/close`, { units: 'ALL' });
    const fill = data.orderFillTransaction;
    const closed = fill?.tradesClosed?.[0];
    const exitPrice = parseFloat(closed?.price ?? fill?.price ?? '0');
    const realizedPnl = parseFloat(closed?.realizedPL ?? '0');
    const unitsAbs = Math.abs(parseFloat(closed?.units ?? '0'));
    return {
      brokerTradeId,
      symbol: fill?.instrument ?? '',
      side: (parseFloat(closed?.units ?? '0') < 0 ? 'BUY' : 'SELL') as Side, // закрытие BUY — отрицательные юниты
      units: unitsAbs,
      entryPrice: 0,
      openedAt: new Date(0),
      exitPrice,
      closedAt: new Date(fill?.time ?? Date.now()),
      realizedPnl,
      closeReason: 'MANUAL',
    };
  }

  async closeAll(): Promise<ClosedPosition[]> {
    const positions = await this.listPositions();
    const out: ClosedPosition[] = [];
    for (const p of positions) {
      out.push(await this.closePosition(p.brokerTradeId));
    }
    return out;
  }

  async listPositions(): Promise<Position[]> {
    const data = await this.rest<any>('GET', `/v3/accounts/${this.cfg.accountId}/openTrades`);
    return (data.trades ?? []).map((t: any): Position => ({
      brokerTradeId: String(t.id),
      symbol: t.instrument,
      side: parseFloat(t.currentUnits) > 0 ? 'BUY' : 'SELL',
      units: Math.abs(parseFloat(t.currentUnits)),
      entryPrice: parseFloat(t.price),
      slPrice: t.stopLossOrder ? parseFloat(t.stopLossOrder.price) : undefined,
      tpPrice: t.takeProfitOrder ? parseFloat(t.takeProfitOrder.price) : undefined,
      openedAt: new Date(t.openTime),
      unrealizedPnl: parseFloat(t.unrealizedPL ?? '0'),
    }));
  }

  async getClosedTrade(brokerTradeId: string): Promise<ClosedPosition | null> {
    try {
      const data = await this.rest<any>('GET', `/v3/accounts/${this.cfg.accountId}/trades/${brokerTradeId}`);
      const t = data.trade;
      if (!t || t.state !== 'CLOSED') return null;
      const side: Side = parseFloat(t.initialUnits) > 0 ? 'BUY' : 'SELL';
      return {
        brokerTradeId,
        symbol: t.instrument,
        side,
        units: Math.abs(parseFloat(t.initialUnits)),
        entryPrice: parseFloat(t.price),
        openedAt: new Date(t.openTime),
        exitPrice: parseFloat(t.averageClosePrice ?? t.price),
        closedAt: new Date(t.closeTime ?? Date.now()),
        realizedPnl: parseFloat(t.realizedPL ?? '0'),
        closeReason: 'RECONCILED',
      };
    } catch {
      return null;
    }
  }

  async limitOrder(req: LimitOrderRequest): Promise<{ orderId: string }> {
    const units = req.side === 'BUY' ? req.units : -req.units;
    const gtdTime = new Date(Date.now() + req.ttlSec * 1000).toISOString();
    const order: Record<string, unknown> = {
      type: 'LIMIT',
      instrument: req.symbol,
      units: String(units),
      price: req.price.toFixed(5),
      timeInForce: 'GTD',
      gtdTime,
      positionFill: 'DEFAULT',
      tradeClientExtensions: { id: req.tag.slice(0, 90) },
    };
    if (req.slPrice !== undefined) order.stopLossOnFill = { price: req.slPrice.toFixed(5) };
    if (req.tpPrice !== undefined) order.takeProfitOnFill = { price: req.tpPrice.toFixed(5) };
    const data = await this.rest<any>('POST', `/v3/accounts/${this.cfg.accountId}/orders`, { order });
    const orderId = data.orderCreateTransaction?.id ?? data.lastTransactionID;
    if (!orderId) {
      throw new Error(`OANDA: лимитный ордер не создан: ${JSON.stringify(data).slice(0, 300)}`);
    }
    return { orderId: String(orderId) };
  }

  async checkOrder(orderId: string): Promise<OrderCheck> {
    try {
      const data = await this.rest<any>('GET', `/v3/accounts/${this.cfg.accountId}/orders/${orderId}`);
      const o = data.order;
      if (!o) return { state: 'GONE' };
      if (o.state === 'PENDING') return { state: 'PENDING' };
      if (o.state === 'FILLED') {
        if (o.fillingTransactionID) {
          const tx = await this.rest<any>('GET', `/v3/accounts/${this.cfg.accountId}/transactions/${o.fillingTransactionID}`);
          const fill = tx.transaction;
          const tradeId = fill?.tradeOpened?.tradeID;
          if (tradeId) {
            return {
              state: 'FILLED',
              brokerTradeId: String(tradeId),
              fillPrice: parseFloat(fill.price),
              filledAt: new Date(fill.time),
            };
          }
        }
        return { state: 'GONE' };
      }
      return { state: 'GONE' }; // CANCELLED / EXPIRED
    } catch {
      return { state: 'GONE' };
    }
  }

  async cancelOrder(orderId: string): Promise<void> {
    try {
      await this.rest('PUT', `/v3/accounts/${this.cfg.accountId}/orders/${orderId}/cancel`);
    } catch {
      // уже исполнен или отменён — не страшно
    }
  }

  async accountState(): Promise<AccountState> {
    const data = await this.rest<any>('GET', `/v3/accounts/${this.cfg.accountId}/summary`);
    const a = data.account;
    return {
      currency: a.currency,
      balance: parseFloat(a.balance),
      equity: parseFloat(a.NAV ?? a.balance),
      openPositionCount: parseInt(a.openTradeCount ?? '0', 10),
    };
  }
}
