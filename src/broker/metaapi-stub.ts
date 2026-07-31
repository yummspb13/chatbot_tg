// Альтернативный адаптер для MetaTrader 5 (Exness — стек из того самого видео)
// через MetaApi.cloud (npm: metaapi.cloud-sdk; один MT-аккаунт на MetaApi бесплатен).
//
// Зачем может понадобиться: если в вашей юрисдикции нельзя открыть OANDA,
// Exness/другой MT5-брокер + MetaApi даёт тот же ExecutionAdapter-контракт:
//   - котировки: connection.subscribeToMarketData('EURUSD') + synchronization listener
//   - ордер:     connection.createMarketBuyOrder('EURUSD', 0.01, sl, tp) / createMarketSellOrder
//                (объём в ЛОТАХ: 0.01 лота = 1000 юнитов в нашей терминологии)
//   - позиции:   connection.terminalState.positions
//   - закрытие:  connection.closePosition(positionId)
//   - счёт:      terminalState.accountInformation (balance, equity)
//
// Подключение: MetaApi токен + провижининг MT5-аккаунта в их дашборде,
// затем `new MetaApi(token).metatraderAccountApi.getAccount(accountId)` →
// `account.getRPCConnection()` / `getStreamingConnection()`.
//
// Пока не реализовано: для теста выбран OANDA (чище API, сделки от 1 юнита).

import {
  AccountState, ClosedPosition, ExecutionAdapter, OrderRequest, OrderResult, Position, Quote,
} from './types';

export class MetaApiAdapter implements ExecutionAdapter {
  readonly name = 'metaapi' as const;

  private fail(): never {
    throw new Error('MetaApi-адаптер не реализован — см. комментарий в src/broker/metaapi-stub.ts (для теста используется OANDA)');
  }

  // eslint-disable-next-line require-yield
  async *streamQuotes(_symbol: string, _signal: AbortSignal): AsyncGenerator<Quote> {
    this.fail();
  }
  async marketOrder(_req: OrderRequest): Promise<OrderResult> { this.fail(); }
  async closePosition(_id: string): Promise<ClosedPosition> { this.fail(); }
  async closeAll(): Promise<ClosedPosition[]> { this.fail(); }
  async listPositions(): Promise<Position[]> { this.fail(); }
  async accountState(): Promise<AccountState> { this.fail(); }
}
