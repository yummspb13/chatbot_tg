// Торговые вызовы T-Invest API — ПЕРВЫЙ файл проекта с ордерами на Тинькофф.
// Появился по явному решению владельца 18.08.2026: депозит 20 000 ₽, micro-этап
// AFKS (зеркало лицензированного виртуала afks-matrend, 14/14 сделок за 2 нед).
//
// Два контура ОДНИМ кодом: sandbox=true → SandboxService.* (фейковые деньги,
// прогон цепочки), sandbox=false → OrdersService/StopOrdersService (боевой счёт).
// Поля запросов/ответов у песочницы и боевого идентичны по контракту v2.
// Ограничение песочницы: стоп-ордера не поддерживаются — биржевая стоп-страховка
// ставится только в боевом контуре (в песочнице позицию ведёт сам виртуал).

import { randomUUID } from 'node:crypto';
import { moneyNum, TinkoffClient, toMoney } from './tinkoff';

export type OrderDirection = 'BUY' | 'SELL';

export interface OrderStateInfo {
  status: string;        // EXECUTION_REPORT_STATUS_*
  lotsExecuted: number;
  avgPrice: number | null; // средняя цена исполнения, ₽/акция
}

const DIR = (d: OrderDirection) => (d === 'BUY' ? 'ORDER_DIRECTION_BUY' : 'ORDER_DIRECTION_SELL');

export class TinkoffTrader extends TinkoffClient {
  constructor(token: string, private sandbox: boolean) {
    super(token);
  }

  isSandbox(): boolean {
    return this.sandbox;
  }

  /** Счёт для торговли: песочница — существующий открытый или новый (+20к ₽
   *  фейковых, как у владельца); боевой — явный env-ид или первый открытый. */
  async ensureAccount(preferred?: string | null): Promise<string> {
    if (this.sandbox) {
      const d = await this.call<any>('SandboxService', 'GetSandboxAccounts', {});
      const open = (d.accounts ?? []).find((a: any) => a.status === 'ACCOUNT_STATUS_OPEN');
      if (open) return open.id as string;
      const c = await this.call<any>('SandboxService', 'OpenSandboxAccount', {});
      await this.call('SandboxService', 'SandboxPayIn', {
        accountId: c.accountId, amount: { ...toMoney(20_000), currency: 'rub' },
      });
      return c.accountId as string;
    }
    if (preferred) return preferred;
    const d = await this.call<any>('UsersService', 'GetAccounts', {});
    const acc = (d.accounts ?? []).find(
      (a: any) => a.status === 'ACCOUNT_STATUS_OPEN' && a.type === 'ACCOUNT_TYPE_TINKOFF',
    ) ?? (d.accounts ?? []).find((a: any) => a.status === 'ACCOUNT_STATUS_OPEN');
    if (!acc) throw new Error('нет открытого брокерского счёта');
    return acc.id as string;
  }

  /** Свободные рубли на счёте (для предполётного чека). */
  async cashRub(accountId: string): Promise<number | null> {
    const svc = this.sandbox ? 'SandboxService' : 'OperationsService';
    const method = this.sandbox ? 'GetSandboxPortfolio' : 'GetPortfolio';
    const d = await this.call<any>(svc, method, { accountId, currency: 'RUB' });
    return moneyNum(d.totalAmountCurrencies);
  }

  /** Позиция по инструменту в ШТУКАХ (не лотах); 0 — нет. */
  async positionQty(accountId: string, uid: string): Promise<number> {
    const svc = this.sandbox ? 'SandboxService' : 'OperationsService';
    const method = this.sandbox ? 'GetSandboxPositions' : 'GetPositions';
    const d = await this.call<any>(svc, method, { accountId });
    const row = (d.securities ?? []).find((s: any) => s.instrumentUid === uid);
    return row ? Number(row.balance ?? 0) : 0;
  }

  async postLimit(p: {
    accountId: string; uid: string; lots: number; price: number; direction: OrderDirection;
  }): Promise<string> {
    const svc = this.sandbox ? 'SandboxService' : 'OrdersService';
    const method = this.sandbox ? 'PostSandboxOrder' : 'PostOrder';
    const d = await this.call<any>(svc, method, {
      accountId: p.accountId,
      instrumentId: p.uid,
      quantity: String(p.lots),
      price: toMoney(p.price),
      direction: DIR(p.direction),
      orderType: 'ORDER_TYPE_LIMIT',
      orderId: randomUUID(), // идемпотентность на ретраях сети
    });
    return d.orderId as string;
  }

  async postMarket(p: {
    accountId: string; uid: string; lots: number; direction: OrderDirection;
  }): Promise<string> {
    const svc = this.sandbox ? 'SandboxService' : 'OrdersService';
    const method = this.sandbox ? 'PostSandboxOrder' : 'PostOrder';
    const d = await this.call<any>(svc, method, {
      accountId: p.accountId,
      instrumentId: p.uid,
      quantity: String(p.lots),
      direction: DIR(p.direction),
      orderType: 'ORDER_TYPE_MARKET',
      orderId: randomUUID(),
    });
    return d.orderId as string;
  }

  async orderState(accountId: string, orderId: string): Promise<OrderStateInfo> {
    const svc = this.sandbox ? 'SandboxService' : 'OrdersService';
    const method = this.sandbox ? 'GetSandboxOrderState' : 'GetOrderState';
    const d = await this.call<any>(svc, method, { accountId, orderId });
    return {
      status: String(d.executionReportStatus ?? ''),
      lotsExecuted: Number(d.lotsExecuted ?? 0),
      avgPrice: moneyNum(d.averagePositionPrice) ?? moneyNum(d.executedOrderPrice),
    };
  }

  async cancelOrder(accountId: string, orderId: string): Promise<void> {
    const svc = this.sandbox ? 'SandboxService' : 'OrdersService';
    const method = this.sandbox ? 'CancelSandboxOrder' : 'CancelOrder';
    await this.call(svc, method, { accountId, orderId });
  }

  /** Биржевой стоп-лосс — страховка на случай смерти процесса. Только боевой
   *  контур (песочница стопы не поддерживает) — там вернёт null. */
  async postStopLoss(p: {
    accountId: string; uid: string; lots: number; stopPrice: number; direction: OrderDirection; // направление ЗАКРЫТИЯ
  }): Promise<string | null> {
    if (this.sandbox) return null;
    const d = await this.call<any>('StopOrdersService', 'PostStopOrder', {
      accountId: p.accountId,
      instrumentId: p.uid,
      quantity: String(p.lots),
      stopPrice: toMoney(p.stopPrice),
      direction: p.direction === 'BUY' ? 'STOP_ORDER_DIRECTION_BUY' : 'STOP_ORDER_DIRECTION_SELL',
      expirationType: 'STOP_ORDER_EXPIRATION_TYPE_GOOD_TILL_CANCEL',
      stopOrderType: 'STOP_ORDER_TYPE_STOP_LOSS',
      exchangeOrderType: 'EXCHANGE_ORDER_TYPE_MARKET',
    });
    return (d.stopOrderId as string) ?? null;
  }

  async cancelStop(accountId: string, stopOrderId: string): Promise<void> {
    if (this.sandbox) return;
    await this.call('StopOrdersService', 'CancelStopOrder', { accountId, stopOrderId });
  }

  /** Активные стоп-ордера счёта (песочница их не поддерживает — пусто). */
  async stopOrders(accountId: string): Promise<Array<{ stopOrderId: string; instrumentUid: string }>> {
    if (this.sandbox) return [];
    const d = await this.call<any>('StopOrdersService', 'GetStopOrders', { accountId });
    return (d.stopOrders ?? []).map((s: any) => ({
      stopOrderId: String(s.stopOrderId),
      instrumentUid: String(s.instrumentUid ?? ''),
    }));
  }
}
