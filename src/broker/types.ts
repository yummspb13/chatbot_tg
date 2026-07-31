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

export interface LimitOrderRequest {
  symbol: string;
  side: Side;
  units: number;
  price: number;    // лимитная цена входа (пассивный вход — спред не платим)
  slPrice?: number;
  tpPrice?: number;
  ttlSec: number;   // срок жизни (GTD); дальше отменяется
  tag: string;      // клиентская метка для связывания ордер → сделка
}

export type OrderCheck =
  | { state: 'PENDING' }
  | { state: 'FILLED'; brokerTradeId: string; fillPrice: number; filledAt: Date }
  | { state: 'GONE' }; // отменён / истёк / не найден

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
  /** Лимитные входы (entryMode=limit). Опционально — движок проверяет наличие. */
  limitOrder?(req: LimitOrderRequest): Promise<{ orderId: string }>;
  checkOrder?(orderId: string): Promise<OrderCheck>;
  cancelOrder?(orderId: string): Promise<void>;
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
