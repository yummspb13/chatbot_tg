// Зеркало afks-matrend: живые виртуальные сделки лицензированного участника
// (14/14 за 2 недели) повторяются реальными лимитками на счёте Тинькофф.
// Micro-этап по решению владельца 18.08.2026 (20 000 ₽): меряем, совпадает ли
// РЕАЛЬНОЕ исполнение (спред, проскальзывание, комиссия 0.05%/сторона на
// «Трейдере») с виртуальной моделью, на которой набрана лицензия.
//
// Механика: вход виртуала → лимитка по его цене + допуск 2 шага; не залилась за
// 90с → отмена, сделка «пропущена» (честный лог расхождения). После входа в
// боевом контуре ставится биржевой стоп-лосс — страховка от смерти процесса.
// Выход виртуала → закрывающая лимитка; не залилась за 90с → маркет (выход
// гарантирован). Все три события идут в Telegram: 🟢 вход · 🔴 выход · итог.
//
// Жёсткая рамка: ≤1 позиция, дневной стоп −500 ₽ (реальный PnL зеркала),
// торговля только в сессию MOEX, kill-switch AFKS_LIVE=0.

import { config } from '../config';
import { errMsg, log } from '../logger';
import { TinkoffTrader } from '../broker/tinkoff-orders';
import { sleep } from '../broker/types';
import { VirtualTradeEvent } from './ensemble';
import { moexInSession } from './moexleg';

export interface MirrorDeps {
  notify: (text: string) => Promise<void>;
}

interface MirrorPosition {
  virtRowId: number;
  side: 'BUY' | 'SELL';
  lots: number;
  qty: number;          // штук
  entryPrice: number;   // фактическая средняя, ₽
  virtEntry: number;    // цена виртуала, ₽ — для сверки исполнения
  stopOrderId: string | null;
  openedAt: number;
}

const FILL_WAIT_MS = 90_000;
const POLL_MS = 5_000;

const rub = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}₽`;

export class AfksMirror {
  private trader: TinkoffTrader | null = null;
  private accountId = '';
  private uid = '';
  private lotSize = 100;
  private priceStep = 0.001;
  private pos: MirrorPosition | null = null;
  private busy = false;          // сериализация: события зеркалим по одному
  private dayKey = '';
  private dayPnl = 0;
  private dayTrades = 0;
  private dayStopNotified = false;
  private skipped = 0;
  private lastError: string | null = null;
  private running = false;

  constructor(private deps: MirrorDeps) {}

  mode(): 'off' | 'sandbox' | 'live' {
    return config.afksLive;
  }

  isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    if (config.afksLive === 'off') return;
    if (!config.tinkoffToken) throw new Error('нет TINKOFF_TOKEN');
    this.trader = new TinkoffTrader(config.tinkoffToken, config.afksLive === 'sandbox');
    this.accountId = await this.trader.ensureAccount(config.afksAccountId);
    const info = await this.trader.shareInfo('AFKS');
    this.uid = info.uid;
    this.lotSize = info.lot;
    this.priceStep = info.priceStep;
    // сироты: на счёте есть AFKS, а виртуал (усыновляющий свои позиции из БД)
    // пришлёт close только для того, что открывал он. Всё живое зеркало
    // восстановить нельзя без persist — честно закрываем остаток маркетом.
    const qty = await this.trader.positionQty(this.accountId, this.uid);
    if (qty !== 0) {
      const lots = Math.round(Math.abs(qty) / this.lotSize);
      if (lots > 0) {
        await this.trader.postMarket({
          accountId: this.accountId, uid: this.uid, lots,
          direction: qty > 0 ? 'SELL' : 'BUY',
        });
        await this.deps.notify(
          `⚠️ AFKS-зеркало: на счёте найдена позиция ${qty} шт без родителя (рестарт?) — закрыта маркетом.`,
        );
      }
    }
    this.running = true;
    const cash = await this.trader.cashRub(this.accountId).catch(() => null);
    log.success(
      `AFKS-зеркало запущено (${config.afksLive}): счёт ${this.accountId}, лот ${this.lotSize} шт, ` +
      `${config.afksLots} лот(ов)/сделка, шаг ${this.priceStep}, кэш ${cash === null ? '?' : cash.toFixed(0) + '₽'}`,
      undefined, 'afks',
    );
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.trader?.shutdown().catch(() => {});
    this.trader = null;
  }

  /** Вход из MoexLeg: событие afks-matrend с ценами, УЖЕ переведёнными в ₽. */
  onVirtual(e: VirtualTradeEvent & { priceRub: number; tpRub?: number; slRub?: number }): void {
    if (!this.running || !this.trader) return;
    // очередь длиной 1: пока зеркалим предыдущее событие, вход не принимаем
    // (close дождётся следующего события виртуала не может — поэтому close
    // обрабатываем всегда, вход при занятости пропускаем)
    void this.handle(e).catch(async err => {
      this.lastError = errMsg(err);
      log.error(`AFKS-зеркало: ${this.lastError}`, undefined, 'afks');
      await this.deps.notify(`🚨 AFKS-зеркало: ошибка — ${this.lastError}`).catch(() => {});
    });
  }

  private rounded(price: number): number {
    return Math.round(price / this.priceStep) * this.priceStep;
  }

  private rollDay(now: Date): void {
    const key = now.toISOString().slice(0, 10);
    if (key !== this.dayKey) {
      this.dayKey = key;
      this.dayPnl = 0;
      this.dayTrades = 0;
      this.dayStopNotified = false;
    }
  }

  private async handle(e: VirtualTradeEvent & { priceRub: number; tpRub?: number; slRub?: number }): Promise<void> {
    if (e.kind === 'open') {
      await this.handleOpen(e);
    } else {
      await this.handleClose(e);
    }
  }

  private async handleOpen(e: VirtualTradeEvent & { priceRub: number; tpRub?: number; slRub?: number }): Promise<void> {
    const t = this.trader!;
    this.rollDay(e.time);
    if (this.busy || this.pos) {
      this.skipped += 1;
      return; // уже есть позиция/операция — зеркало строго ≤1
    }
    if (!moexInSession(new Date())) return;
    if (this.dayPnl <= -config.afksDailyLossRub) {
      if (!this.dayStopNotified) {
        this.dayStopNotified = true;
        await this.deps.notify(`⛔️ AFKS-зеркало: дневной стоп ${rub(this.dayPnl)} — входов до завтра не будет.`);
      }
      return;
    }
    this.busy = true;
    try {
      const qty = config.afksLots * this.lotSize;
      // допуск 2 шага в сторону исполнения: BUY чуть дороже, SELL чуть дешевле
      const price = this.rounded(e.priceRub + (e.side === 'BUY' ? 2 : -2) * this.priceStep);
      const orderId = await t.postLimit({
        accountId: this.accountId, uid: this.uid, lots: config.afksLots, price, direction: e.side,
      });
      const st = await this.waitFill(orderId);
      if (!st.filled) {
        await t.cancelOrder(this.accountId, orderId).catch(() => {});
        // отмена и филл могли пересечься — перепроверяем позицию
        const after = await t.positionQty(this.accountId, this.uid);
        if (after === 0) {
          this.skipped += 1;
          await this.deps.notify(
            `⚠️ AFKS: вход виртуала @${e.priceRub.toFixed(3)}₽ НЕ исполнился за 90с (лимит ${price.toFixed(3)}) — сделка пропущена. Пропусков: ${this.skipped}.`,
          );
          return;
        }
      }
      const entry = st.avgPrice ?? price;
      const slRub = e.slRub ?? null;
      let stopOrderId: string | null = null;
      if (slRub !== null) {
        stopOrderId = await t.postStopLoss({
          accountId: this.accountId, uid: this.uid, lots: config.afksLots,
          stopPrice: this.rounded(slRub),
          direction: e.side === 'BUY' ? 'SELL' : 'BUY',
        }).catch(err => {
          log.warn(`AFKS: стоп-страховка не поставилась: ${errMsg(err)}`, undefined, 'afks');
          return null;
        });
      }
      this.pos = {
        virtRowId: e.rowId, side: e.side, lots: config.afksLots, qty,
        entryPrice: entry, virtEntry: e.priceRub, stopOrderId, openedAt: Date.now(),
      };
      const fee = entry * qty * config.afksFeeFrac;
      const risk = slRub !== null ? Math.abs(entry - slRub) * qty : null;
      await this.deps.notify(
        `🟢 AFKS вход (${config.afksLive === 'sandbox' ? 'ПЕСОЧНИЦА' : 'СЧЁТ'}): ${e.side} ${config.afksLots} лот × ${this.lotSize} = ${qty} шт @ ${entry.toFixed(3)}₽` +
        `\nвиртуал @ ${e.priceRub.toFixed(3)} · слип ${((entry - e.priceRub) * (e.side === 'BUY' ? 1 : -1) * qty).toFixed(1)}₽` +
        `\nстоп ${slRub === null ? '—' : this.rounded(slRub).toFixed(3)}${this.pos.stopOrderId ? ' (на бирже)' : ''} · цель ${e.tpRub === undefined ? '—' : this.rounded(e.tpRub).toFixed(3)}` +
        `\nриск ~${risk === null ? '?' : risk.toFixed(0)}₽ · комиссия входа ${fee.toFixed(2)}₽`,
      );
    } finally {
      this.busy = false;
    }
  }

  private async handleClose(e: VirtualTradeEvent & { priceRub: number }): Promise<void> {
    const t = this.trader!;
    const pos = this.pos;
    if (!pos || pos.virtRowId !== e.rowId) return; // не наша (вход был пропущен)
    this.busy = true;
    try {
      if (pos.stopOrderId) await t.cancelStop(this.accountId, pos.stopOrderId).catch(() => {});
      const closeDir = pos.side === 'BUY' ? 'SELL' : 'BUY';
      const price = this.rounded(e.priceRub + (closeDir === 'BUY' ? 2 : -2) * this.priceStep);
      let exit: number | null = null;
      const orderId = await t.postLimit({
        accountId: this.accountId, uid: this.uid, lots: pos.lots, price, direction: closeDir,
      });
      const st = await this.waitFill(orderId);
      if (st.filled) {
        exit = st.avgPrice ?? price;
      } else {
        await t.cancelOrder(this.accountId, orderId).catch(() => {});
        const left = await t.positionQty(this.accountId, this.uid);
        if (left !== 0) {
          const mkt = await t.postMarket({
            accountId: this.accountId, uid: this.uid,
            lots: Math.max(1, Math.round(Math.abs(left) / this.lotSize)), direction: closeDir,
          });
          const st2 = await this.waitFill(mkt);
          exit = st2.avgPrice ?? e.priceRub;
        } else {
          exit = st.avgPrice ?? price; // лимитка успела исполниться в гонке с отменой
        }
      }
      const gross = (pos.side === 'BUY' ? exit - pos.entryPrice : pos.entryPrice - exit) * pos.qty;
      const fee = (pos.entryPrice + exit) * pos.qty * config.afksFeeFrac;
      const pnl = gross - fee;
      this.rollDay(e.time);
      this.dayPnl += pnl;
      this.dayTrades += 1;
      const minutes = Math.round((Date.now() - pos.openedAt) / 60_000);
      this.pos = null;
      await this.deps.notify(
        `🔴 AFKS выход (${e.reason ?? '—'}): ${exit.toFixed(3)}₽ · виртуал @ ${e.priceRub.toFixed(3)} · ${minutes} мин` +
        `\nИТОГ: ${rub(pnl)} (комиссия ${fee.toFixed(2)}₽ учтена)` +
        `\nдень: ${rub(this.dayPnl)} за ${this.dayTrades} сд · виртуал этой сделки: ${e.pnl === undefined ? '—' : (e.pnl >= 0 ? '+' : '') + e.pnl.toFixed(2)}$`,
      );
    } finally {
      this.busy = false;
    }
  }

  private async waitFill(orderId: string): Promise<{ filled: boolean; avgPrice: number | null }> {
    const t = this.trader!;
    const until = Date.now() + FILL_WAIT_MS;
    let avg: number | null = null;
    while (Date.now() < until) {
      const st = await t.orderState(this.accountId, orderId).catch(() => null);
      if (st) {
        avg = st.avgPrice ?? avg;
        if (st.status === 'EXECUTION_REPORT_STATUS_FILL') return { filled: true, avgPrice: avg };
        if (st.status === 'EXECUTION_REPORT_STATUS_REJECTED' || st.status === 'EXECUTION_REPORT_STATUS_CANCELLED') {
          return { filled: false, avgPrice: avg };
        }
      }
      await sleep(POLL_MS);
    }
    return { filled: false, avgPrice: avg };
  }

  summary() {
    return {
      mode: config.afksLive,
      running: this.running,
      account: this.accountId ? `${this.accountId.slice(0, 4)}…` : null,
      position: this.pos
        ? { side: this.pos.side, qty: this.pos.qty, entry: +this.pos.entryPrice.toFixed(3), minutes: Math.round((Date.now() - this.pos.openedAt) / 60_000) }
        : null,
      dayPnlRub: +this.dayPnl.toFixed(2),
      dayTrades: this.dayTrades,
      skipped: this.skipped,
      lastError: this.lastError,
    };
  }
}
