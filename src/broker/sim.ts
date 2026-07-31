// Симулятор: случайное блуждание с возвратом к «якорю», реалистичный спред и слиппедж.
// Гоняет весь путь движок → БД → уведомления без внешних счетов и риска.

import {
  AccountState, ClosedPosition, ExecutionAdapter, OrderRequest, OrderResult,
  PIP, Position, Quote, round5, sleep,
} from './types';

interface SimPosition extends Position {
  slPrice?: number;
  tpPrice?: number;
}

export class SimAdapter implements ExecutionAdapter {
  readonly name = 'sim' as const;

  private balance: number;
  private mid = 1.085;
  private anchor = 1.085;
  private spread = 0.8 * PIP;
  private positions = new Map<string, SimPosition>();
  private seq = 1;
  private closedCb: ((p: ClosedPosition) => void) | null = null;

  constructor(startBalance: number) {
    this.balance = startBalance;
  }

  onPositionClosed(cb: (p: ClosedPosition) => void): void {
    this.closedCb = cb;
  }

  private gauss(): number {
    let u = 0, v = 0;
    while (!u) u = Math.random();
    while (!v) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  private prices(): { bid: number; ask: number } {
    return { bid: round5(this.mid - this.spread / 2), ask: round5(this.mid + this.spread / 2) };
  }

  private tick(now: Date): void {
    this.anchor += this.gauss() * 0.02 * PIP;
    this.mid += (this.anchor - this.mid) * 0.002 + this.gauss() * 0.35 * PIP;
    this.spread = (0.7 + Math.random() * 0.4) * PIP;

    const { bid, ask } = this.prices();
    for (const [id, p] of [...this.positions]) {
      const px = p.side === 'BUY' ? bid : ask; // закрытие BUY — по bid, SELL — по ask
      let reason: string | null = null;
      if (p.tpPrice !== undefined && (p.side === 'BUY' ? px >= p.tpPrice : px <= p.tpPrice)) reason = 'TP';
      else if (p.slPrice !== undefined && (p.side === 'BUY' ? px <= p.slPrice : px >= p.slPrice)) reason = 'SL';
      if (reason) {
        const closed = this.close(id, px, now, reason);
        if (closed) this.closedCb?.(closed);
      }
    }
  }

  private close(id: string, px: number, when: Date, reason: string): ClosedPosition | null {
    const p = this.positions.get(id);
    if (!p) return null;
    const pnl = (p.side === 'BUY' ? px - p.entryPrice : p.entryPrice - px) * p.units;
    this.balance += pnl;
    this.positions.delete(id);
    return { ...p, exitPrice: px, closedAt: when, realizedPnl: pnl, closeReason: reason };
  }

  async *streamQuotes(symbol: string, signal: AbortSignal): AsyncGenerator<Quote> {
    while (!signal.aborted) {
      await sleep(300 + Math.random() * 500, signal);
      if (signal.aborted) break;
      const now = new Date();
      this.tick(now);
      const { bid, ask } = this.prices();
      yield { symbol, bid, ask, time: now };
    }
  }

  async marketOrder(req: OrderRequest): Promise<OrderResult> {
    const { bid, ask } = this.prices();
    const slip = Math.random() * 0.2 * PIP;
    const fillPrice = round5(req.side === 'BUY' ? ask + slip : bid - slip);
    const id = `sim-${this.seq++}`;
    const now = new Date();
    this.positions.set(id, {
      brokerTradeId: id,
      symbol: req.symbol,
      side: req.side,
      units: req.units,
      entryPrice: fillPrice,
      slPrice: req.slPrice,
      tpPrice: req.tpPrice,
      openedAt: now,
    });
    return { brokerTradeId: id, fillPrice, filledAt: now };
  }

  async closePosition(brokerTradeId: string): Promise<ClosedPosition> {
    const p = this.positions.get(brokerTradeId);
    if (!p) throw new Error(`sim: позиция ${brokerTradeId} не найдена`);
    const { bid, ask } = this.prices();
    const px = p.side === 'BUY' ? bid : ask;
    const closed = this.close(brokerTradeId, px, new Date(), 'MANUAL');
    if (!closed) throw new Error('sim: закрытие не удалось');
    return closed;
  }

  async closeAll(): Promise<ClosedPosition[]> {
    const out: ClosedPosition[] = [];
    for (const id of [...this.positions.keys()]) {
      out.push(await this.closePosition(id));
    }
    return out;
  }

  async listPositions(): Promise<Position[]> {
    const { bid, ask } = this.prices();
    return [...this.positions.values()].map(p => ({
      ...p,
      unrealizedPnl: (p.side === 'BUY' ? bid - p.entryPrice : p.entryPrice - ask) * p.units,
    }));
  }

  async accountState(): Promise<AccountState> {
    const open = await this.listPositions();
    const unrealized = open.reduce((s, p) => s + (p.unrealizedPnl ?? 0), 0);
    return {
      currency: 'USD',
      balance: this.balance,
      equity: this.balance + unrealized,
      openPositionCount: open.length,
    };
  }

  async getClosedTrade(): Promise<ClosedPosition | null> {
    return null; // закрытия приходят через onPositionClosed
  }
}
