// Клиент Binance USDT-M Futures TESTNET (testnet.binancefuture.com) для
// мейкер-эксперимента: post-only лимитки (timeInForce=GTX), нетто-позиция
// (one-way), учёт по userTrades (realizedPnl и commission на каждый филл).
// Денег здесь нет — это песочница биржи с фейковым USDT, но стакан и мэтчинг
// настоящие. SDK не используем: REST + HMAC-подпись, undici.

import { createHmac } from 'node:crypto';
import { request } from 'undici';

export interface BookTop {
  bid: number;
  ask: number;
  ts: number;
}

export interface FuturesOrder {
  orderId: number;
  status: string; // NEW | FILLED | EXPIRED | CANCELED | PARTIALLY_FILLED
  price: number;
  side: 'BUY' | 'SELL';
}

export interface FuturesPosition {
  amt: number;        // >0 лонг, <0 шорт, 0 — флэт (в BTC)
  entryPrice: number;
  unrealized: number; // USDT
}

export interface FuturesFill {
  id: number;
  orderId: number;
  side: 'BUY' | 'SELL';
  price: number;
  qty: number;
  realizedPnl: number;
  commission: number;
  maker: boolean;
  time: number;
}

export interface SymbolRules {
  tickSize: number;
  stepSize: number;
  minQty: number;
}

export class BinanceFuturesClient {
  constructor(
    private key: string,
    private secret: string,
    private base = 'https://testnet.binancefuture.com',
  ) {}

  private async call<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    params: Record<string, string | number | boolean> = {},
    signed = false,
  ): Promise<T> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
    if (signed) {
      qs.set('timestamp', String(Date.now()));
      qs.set('recvWindow', '5000');
      qs.set('signature', createHmac('sha256', this.secret).update(qs.toString()).digest('hex'));
    }
    const url = `${this.base}${path}?${qs.toString()}`;
    const res = await request(url, {
      method,
      headers: this.key ? { 'X-MBX-APIKEY': this.key } : {},
      headersTimeout: 10_000,
      bodyTimeout: 10_000,
    });
    const text = await res.body.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`binance ${path}: HTTP ${res.statusCode} не-JSON: ${text.slice(0, 120)}`);
    }
    const err = json as { code?: number; msg?: string };
    if (res.statusCode >= 400 || (typeof err.code === 'number' && err.code < 0)) {
      throw new Error(`binance ${path}: ${err.code} ${err.msg ?? text.slice(0, 120)}`);
    }
    return json as T;
  }

  async bookTicker(symbol: string): Promise<BookTop> {
    const r = await this.call<{ bidPrice: string; askPrice: string; time?: number }>(
      'GET', '/fapi/v1/ticker/bookTicker', { symbol },
    );
    return { bid: Number(r.bidPrice), ask: Number(r.askPrice), ts: r.time ?? Date.now() };
  }

  async symbolRules(symbol: string): Promise<SymbolRules> {
    const r = await this.call<{ symbols: Array<{ symbol: string; filters: Array<Record<string, string>> }> }>(
      'GET', '/fapi/v1/exchangeInfo', { symbol },
    );
    const s = r.symbols.find(x => x.symbol === symbol) ?? r.symbols[0];
    const price = s.filters.find(f => f.filterType === 'PRICE_FILTER');
    const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
    return {
      tickSize: Number(price?.tickSize ?? '0.1'),
      stepSize: Number(lot?.stepSize ?? '0.001'),
      minQty: Number(lot?.minQty ?? '0.001'),
    };
  }

  /** Post-only (GTX): если бы ордер немедленно исполнился — биржа его отбрасывает
   *  (status EXPIRED или код -5022). Возвращаем null в этом случае. */
  async placePostOnly(
    symbol: string, side: 'BUY' | 'SELL', qty: number, price: number, clientId: string,
  ): Promise<FuturesOrder | null> {
    try {
      const r = await this.call<{ orderId: number; status: string; price: string; side: 'BUY' | 'SELL' }>(
        'POST', '/fapi/v1/order', {
          symbol, side, type: 'LIMIT', timeInForce: 'GTX',
          quantity: qty, price, newClientOrderId: clientId,
        }, true,
      );
      if (r.status === 'EXPIRED') return null;
      return { orderId: r.orderId, status: r.status, price: Number(r.price), side: r.side };
    } catch (e) {
      if (String(e).includes('-5022')) return null; // post-only отклонён — пересечение
      throw e;
    }
  }

  async cancelAll(symbol: string): Promise<void> {
    await this.call('DELETE', '/fapi/v1/allOpenOrders', { symbol }, true);
  }

  async openOrders(symbol: string): Promise<FuturesOrder[]> {
    const r = await this.call<Array<{ orderId: number; status: string; price: string; side: 'BUY' | 'SELL'; time: number }>>(
      'GET', '/fapi/v1/openOrders', { symbol }, true,
    );
    return r.map(o => ({ orderId: o.orderId, status: o.status, price: Number(o.price), side: o.side }));
  }

  async position(symbol: string): Promise<FuturesPosition> {
    const r = await this.call<Array<{ positionAmt: string; entryPrice: string; unRealizedProfit: string }>>(
      'GET', '/fapi/v2/positionRisk', { symbol }, true,
    );
    const p = r[0];
    return p
      ? { amt: Number(p.positionAmt), entryPrice: Number(p.entryPrice), unrealized: Number(p.unRealizedProfit) }
      : { amt: 0, entryPrice: 0, unrealized: 0 };
  }

  /** Закрытие инвентаря по рынку (reduceOnly) — это наш SL, платим тейкера. */
  async marketClose(symbol: string, positionAmt: number): Promise<void> {
    if (!positionAmt) return;
    await this.call('POST', '/fapi/v1/order', {
      symbol,
      side: positionAmt > 0 ? 'SELL' : 'BUY',
      type: 'MARKET',
      quantity: Math.abs(positionAmt),
      reduceOnly: 'true',
    }, true);
  }

  async userTrades(symbol: string, fromId?: number): Promise<FuturesFill[]> {
    const params: Record<string, string | number> = { symbol, limit: 100 };
    if (fromId !== undefined) params.fromId = fromId;
    const r = await this.call<Array<{
      id: number; orderId: number; side: 'BUY' | 'SELL'; price: string; qty: string;
      realizedPnl: string; commission: string; maker: boolean; time: number;
    }>>('GET', '/fapi/v1/userTrades', params, true);
    return r.map(f => ({
      id: f.id, orderId: f.orderId, side: f.side, price: Number(f.price), qty: Number(f.qty),
      realizedPnl: Number(f.realizedPnl), commission: Number(f.commission), maker: f.maker, time: f.time,
    }));
  }

  async balanceUsdt(): Promise<{ balance: number; available: number }> {
    const r = await this.call<Array<{ asset: string; balance: string; availableBalance: string }>>(
      'GET', '/fapi/v2/balance', {}, true,
    );
    const u = r.find(b => b.asset === 'USDT');
    return { balance: Number(u?.balance ?? 0), available: Number(u?.availableBalance ?? 0) };
  }
}
