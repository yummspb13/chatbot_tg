// Общий интерфейс исполнения: sim | oanda | metaapi.
// «Ставка» из видео = рыночный ордер с SL/TP на стороне брокера.

export const PIP = 0.0001; // EUR/USD

export type Side = 'BUY' | 'SELL';

export interface Quote {
  symbol: string;
  bid: number;
  ask: number;
  time: Date;
}

export interface OrderRequest {
  symbol: string;
  side: Side;
  units: number;
  slPrice?: number;
  tpPrice?: number;
}

export interface OrderResult {
  brokerTradeId: string;
  fillPrice: number;
  filledAt: Date;
}

export interface Position {
  brokerTradeId: string;
  symbol: string;
  side: Side;
  units: number;
  entryPrice: number;
  slPrice?: number;
  tpPrice?: number;
  openedAt: Date;
  unrealizedPnl?: number;
}

export interface ClosedPosition extends Position {
  exitPrice: number;
  closedAt: Date;
  realizedPnl: number;
  closeReason?: string; // TP | SL | MANUAL | KILL | RECONCILED
}

export interface AccountState {
  currency: string;
  balance: number;
  equity: number;
  openPositionCount: number;
}

export interface ExecutionAdapter {
  readonly name: 'sim' | 'oanda' | 'metaapi';
  /** Поток котировок; завершается/кидает при обрыве — реконнект делает движок. */
  streamQuotes(symbol: string, signal: AbortSignal): AsyncGenerator<Quote>;
  marketOrder(req: OrderRequest): Promise<OrderResult>;
  closePosition(brokerTradeId: string): Promise<ClosedPosition>;
  closeAll(): Promise<ClosedPosition[]>;
  listPositions(): Promise<Position[]>;
  accountState(): Promise<AccountState>;
  /** Пуш о закрытии позиции брокером (TP/SL). Резервный путь — reconcile-опрос движка. */
  onPositionClosed?(cb: (p: ClosedPosition) => void): void;
  /** Детали уже закрытой сделки для reconcile (если брокер умеет). */
  getClosedTrade?(brokerTradeId: string): Promise<ClosedPosition | null>;
}

export function round5(p: number): number {
  return Math.round(p * 100000) / 100000;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const t = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', done);
      clearTimeout(t);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}
