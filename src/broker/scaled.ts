// Масштабирующая обёртка адаптера для крипто-CFD: движок и стратегии живут
// в мире «пип = 0.0001», а брокер — в реальных ценах (BTC ~64000, ETH ~1900).
// Цены делятся на scale на входе в движок и умножаются обратно при отправке
// ордеров; юниты движка переводятся в юниты внутреннего адаптера так, чтобы
// лоты у брокера получались правильные (metaapi: лоты = юниты/100000, а нам
// нужно лоты = юниты/scale → фактор = 100000/scale).
//
// PnL/балансы НЕ трогаем — брокер считает их в реальных USD, и благодаря
// выбору scale стоимость «пипса» в масштабе совпадает с реальной.
// Позиции ЧУЖИХ символов (например EURUSDm на том же счёте) проходят сквозь
// без изменений — масштабируется только свой mt5Symbol.

import {
  AccountState, ClosedPosition, ExecutionAdapter, LimitOrderRequest, OrderCheck,
  OrderRequest, OrderResult, Position, Quote,
} from './types';

export interface ScaleConfig {
  mt5Symbol: string; // масштабируем только этот символ
  scale: number;     // делитель цены (BTC 100000, ETH 10000)
  digits: number;    // знаков после запятой в реальной цене MT5
}

export class ScaledAdapter implements ExecutionAdapter {
  readonly name: ExecutionAdapter['name'];
  private readonly unitsFactor: number;

  constructor(private inner: ExecutionAdapter, private cfg: ScaleConfig) {
    this.name = inner.name;
    this.unitsFactor = 100_000 / cfg.scale;
  }

  private toReal(p: number): number {
    const f = 10 ** this.cfg.digits;
    return Math.round(p * this.cfg.scale * f) / f;
  }

  private toScaled(p: number): number {
    return p / this.cfg.scale;
  }

  private isOurs(symbol: string | undefined): boolean {
    return symbol === this.cfg.mt5Symbol;
  }

  private descalePosition<T extends Position>(p: T): T {
    if (!this.isOurs(p.symbol)) return p;
    return {
      ...p,
      units: Math.round(p.units / this.unitsFactor),
      entryPrice: this.toScaled(p.entryPrice),
      slPrice: p.slPrice !== undefined ? this.toScaled(p.slPrice) : undefined,
      tpPrice: p.tpPrice !== undefined ? this.toScaled(p.tpPrice) : undefined,
    };
  }

  private descaleClosed(c: ClosedPosition): ClosedPosition {
    if (!this.isOurs(c.symbol)) return c;
    return {
      ...this.descalePosition(c),
      exitPrice: this.toScaled(c.exitPrice),
    };
  }

  async *streamQuotes(symbol: string, signal: AbortSignal): AsyncGenerator<Quote> {
    for await (const q of this.inner.streamQuotes(symbol, signal)) {
      yield { ...q, bid: this.toScaled(q.bid), ask: this.toScaled(q.ask) };
    }
  }

  async marketOrder(req: OrderRequest): Promise<OrderResult> {
    const res = await this.inner.marketOrder({
      ...req,
      units: Math.round(req.units * this.unitsFactor),
      slPrice: req.slPrice !== undefined ? this.toReal(req.slPrice) : undefined,
      tpPrice: req.tpPrice !== undefined ? this.toReal(req.tpPrice) : undefined,
    });
    return { ...res, fillPrice: this.toScaled(res.fillPrice) };
  }

  async limitOrder(req: LimitOrderRequest): Promise<{ orderId: string }> {
    if (!this.inner.limitOrder) throw new Error('внутренний адаптер не умеет лимитные ордера');
    return this.inner.limitOrder({
      ...req,
      units: Math.round(req.units * this.unitsFactor),
      price: this.toReal(req.price),
      slPrice: req.slPrice !== undefined ? this.toReal(req.slPrice) : undefined,
      tpPrice: req.tpPrice !== undefined ? this.toReal(req.tpPrice) : undefined,
    });
  }

  async checkOrder(orderId: string): Promise<OrderCheck> {
    if (!this.inner.checkOrder) return { state: 'GONE' };
    const check = await this.inner.checkOrder(orderId);
    if (check.state === 'FILLED') return { ...check, fillPrice: this.toScaled(check.fillPrice) };
    return check;
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.inner.cancelOrder?.(orderId);
  }

  async closePosition(brokerTradeId: string): Promise<ClosedPosition> {
    return this.descaleClosed(await this.inner.closePosition(brokerTradeId));
  }

  async closeAll(): Promise<ClosedPosition[]> {
    return (await this.inner.closeAll()).map(c => this.descaleClosed(c));
  }

  async listPositions(): Promise<Position[]> {
    return (await this.inner.listPositions()).map(p => this.descalePosition(p));
  }

  async getClosedTrade(brokerTradeId: string): Promise<ClosedPosition | null> {
    if (!this.inner.getClosedTrade) return null;
    const c = await this.inner.getClosedTrade(brokerTradeId);
    return c ? this.descaleClosed(c) : null;
  }

  async accountState(): Promise<AccountState> {
    return this.inner.accountState();
  }

  onPositionClosed(cb: (p: ClosedPosition) => void): void {
    this.inner.onPositionClosed?.(p => cb(this.descaleClosed(p)));
  }

  async shutdown(): Promise<void> {
    await this.inner.shutdown?.();
  }
}
