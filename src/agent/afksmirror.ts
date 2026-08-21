// Зеркало виртуального участника MOEX-ноги: живые сделки ЛИЦЕНЗИРОВАННОГО
// виртуала повторяются реальными лимитками на счёте Тинькофф. Micro-этап по
// решению владельца 18.08.2026 (20 000 ₽); мультитикер с 21.08 (env MIRRORS,
// подключение нового тикера — только при лицензии ≥10 живых сделок/14д, net>0).
// Меряем, совпадает ли РЕАЛЬНОЕ исполнение (спред, проскальзывание, комиссия
// 0.05%/сторона на «Трейдере») с виртуальной моделью лицензии.
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
  /** Открытая позиция виртуала-родителя (цены УЖЕ в ₽) — для усыновления
   *  сироты после рестарта вместо слепого закрытия. */
  getParentOpen?: () => { rowId: number; side: 'BUY' | 'SELL'; entryRub: number; slRub: number } | null;
}

export interface MirrorCfg {
  ticker: string;     // тикер TQBR (AFKS, SIBN, …)
  memberKey: string;  // виртуал-родитель (afks-matrend, sibn-meanrev, …)
  lots: number;       // лотов на сделку
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

export class TickerMirror {
  // дневной лимит −AFKS_DAILY_LOSS_RUB — ОБЩИЙ на все зеркала счёта
  private static sharedDayKey = '';
  private static sharedDayPnl = 0;

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
  startError: string | null = null; // ставит startMirrorWithRetry (moexleg)
  private running = false;
  private syncTimer: NodeJS.Timeout | null = null;
  private parentMissingTicks = 0;

  constructor(private deps: MirrorDeps, private cfg: MirrorCfg) {}

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
    const info = await this.trader.shareInfo(this.cfg.ticker);
    this.uid = info.uid;
    this.lotSize = info.lot;
    this.priceStep = info.priceStep;
    // висячие стоп-ордера прежнего процесса: id потерян рестартом, а стоп без
    // позиции при срабатывании ОТКРЫЛ бы новую — сносим все по инструменту
    const stops = await this.trader.stopOrders(this.accountId).catch(() => []);
    for (const s of stops) {
      if (s.instrumentUid === this.uid) {
        await this.trader.cancelStop(this.accountId, s.stopOrderId).catch(() => {});
        log.warn(`${this.cfg.ticker}: снят висячий стоп-ордер ${s.stopOrderId} (рестарт)`, undefined, 'afks');
      }
    }
    // позиция на счёте после рестарта: если виртуал-родитель ДЕРЖИТ свою тем же
    // направлением — усыновляем (вход берём из виртуала как оценку, стоп
    // перевыставляем); иначе позиция беспризорная — закрываем маркетом
    const qty = await this.trader.positionQty(this.accountId, this.uid);
    if (qty !== 0) {
      const parent = this.deps.getParentOpen?.() ?? null;
      const sameDir = parent && ((qty > 0 && parent.side === 'BUY') || (qty < 0 && parent.side === 'SELL'));
      const lots = Math.round(Math.abs(qty) / this.lotSize);
      if (sameDir && parent && lots > 0) {
        const stopOrderId = await this.trader.postStopLoss({
          accountId: this.accountId, uid: this.uid, lots,
          stopPrice: this.rounded(parent.slRub),
          direction: parent.side === 'BUY' ? 'SELL' : 'BUY',
        }).catch(() => null);
        this.pos = {
          virtRowId: parent.rowId, side: parent.side, lots, qty: Math.abs(qty),
          entryPrice: parent.entryRub, virtEntry: parent.entryRub, stopOrderId, openedAt: Date.now(),
        };
        await this.deps.notify(
          `♻️ ${this.cfg.ticker}-зеркало: позиция ${qty} шт усыновлена после рестарта (вход ~${parent.entryRub.toFixed(3)}₽ по виртуалу, стоп ${this.rounded(parent.slRub).toFixed(3)} перевыставлен).`,
        );
      } else if (lots > 0) {
        await this.trader.postMarket({
          accountId: this.accountId, uid: this.uid, lots,
          direction: qty > 0 ? 'SELL' : 'BUY',
        });
        await this.deps.notify(
          `⚠️ ${this.cfg.ticker}-зеркало: на счёте позиция ${qty} шт без родителя (рестарт?) — закрыта маркетом.`,
        );
      }
    }
    this.running = true;
    // вотчдог рассинхрона: родитель закрылся, а close-событие потерялось
    // (инцидент 21.08: зеркальный шорт жил час после TP виртуала) — позиция
    // без родителя дольше ~3 минут закрывается маркетом с алертом
    this.syncTimer = setInterval(() => {
      void this.syncCheck().catch(e => log.warn(`${this.cfg.ticker} sync: ${errMsg(e)}`, undefined, 'afks'));
    }, 60_000);
    const cash = await this.trader.cashRub(this.accountId).catch(() => null);
    log.success(
      `${this.cfg.ticker}-зеркало запущено (${config.afksLive}): счёт ${this.accountId}, лот ${this.lotSize} шт, ` +
      `${this.cfg.lots} лот(ов)/сделка, шаг ${this.priceStep}, кэш ${cash === null ? '?' : cash.toFixed(0) + '₽'}`,
      undefined, 'afks',
    );
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    await this.trader?.shutdown().catch(() => {});
    this.trader = null;
  }

  /** Позиция есть, а родитель уже без своей ≥3 минут → закрыть маркетом. */
  private async syncCheck(): Promise<void> {
    if (!this.running || this.busy || !this.pos || !this.trader) return;
    const parent = this.deps.getParentOpen?.();
    if (parent && parent.rowId === this.pos.virtRowId) {
      this.parentMissingTicks = 0;
      return;
    }
    this.parentMissingTicks += 1;
    if (this.parentMissingTicks < 3) return;
    this.parentMissingTicks = 0;
    const pos = this.pos;
    this.busy = true;
    try {
      if (pos.stopOrderId) await this.trader.cancelStop(this.accountId, pos.stopOrderId).catch(() => {});
      const closeDir = pos.side === 'BUY' ? 'SELL' : 'BUY';
      const mkt = await this.trader.postMarket({
        accountId: this.accountId, uid: this.uid, lots: pos.lots, direction: closeDir,
      });
      const st = await this.waitFill(mkt);
      const exit = st.avgPrice ?? pos.entryPrice;
      const gross = (pos.side === 'BUY' ? exit - pos.entryPrice : pos.entryPrice - exit) * pos.qty;
      const fee = (pos.entryPrice + exit) * pos.qty * config.afksFeeFrac;
      const pnl = gross - fee;
      this.rollDay(new Date());
      this.dayPnl += pnl;
      TickerMirror.sharedDayPnl += pnl;
      this.dayTrades += 1;
      this.pos = null;
      await this.deps.notify(
        `⚠️ ${this.cfg.ticker}-зеркало: РАССИНХРОН — виртуал уже без позиции, close-событие потерялось. Закрыл маркетом @ ${exit.toFixed(3)}₽.\nИТОГ: ${rub(pnl)} (комиссия ${fee.toFixed(2)}₽) · день: ${rub(this.dayPnl)}`,
      );
    } finally {
      this.busy = false;
    }
  }

  /** Вход из MoexLeg: событие afks-matrend с ценами, УЖЕ переведёнными в ₽. */
  onVirtual(e: VirtualTradeEvent & { priceRub: number; tpRub?: number; slRub?: number }): void {
    if (!this.running || !this.trader) return;
    // очередь длиной 1: пока зеркалим предыдущее событие, вход не принимаем
    // (close дождётся следующего события виртуала не может — поэтому close
    // обрабатываем всегда, вход при занятости пропускаем)
    void this.handle(e).catch(async err => {
      this.lastError = errMsg(err);
      log.error(`${this.cfg.ticker}-зеркало: ${this.lastError}`, undefined, 'afks');
      // 30042 = шорт без включённой маржинальной торговли — подсказка вместо кода
      const hint = this.lastError.includes('30042')
        ? '\nЭто SELL-сигнал при выключенной маржинальной торговле: включите её в Т-Инвестициях (настройки счёта), иначе шорты будут пропускаться.'
        : '';
      await this.deps.notify(`🚨 ${this.cfg.ticker}-зеркало: ошибка — ${this.lastError}${hint}`).catch(() => {});
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
    if (key !== TickerMirror.sharedDayKey) {
      TickerMirror.sharedDayKey = key;
      TickerMirror.sharedDayPnl = 0;
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
    if (TickerMirror.sharedDayPnl <= -config.afksDailyLossRub) {
      if (!this.dayStopNotified) {
        this.dayStopNotified = true;
        await this.deps.notify(`⛔️ Зеркала: общий дневной стоп ${rub(TickerMirror.sharedDayPnl)} — входов до завтра не будет.`);
      }
      return;
    }
    this.busy = true;
    try {
      const qty = this.cfg.lots * this.lotSize;
      // допуск 2 шага в сторону исполнения: BUY чуть дороже, SELL чуть дешевле
      const price = this.rounded(e.priceRub + (e.side === 'BUY' ? 2 : -2) * this.priceStep);
      const orderId = await t.postLimit({
        accountId: this.accountId, uid: this.uid, lots: this.cfg.lots, price, direction: e.side,
      });
      const st = await this.waitFill(orderId);
      if (!st.filled) {
        await t.cancelOrder(this.accountId, orderId).catch(() => {});
        // отмена и филл могли пересечься — перепроверяем позицию
        const after = await t.positionQty(this.accountId, this.uid);
        if (after === 0) {
          this.skipped += 1;
          await this.deps.notify(
            `⚠️ ${this.cfg.ticker}: вход виртуала @${e.priceRub.toFixed(3)}₽ НЕ исполнился за 90с (лимит ${price.toFixed(3)}) — сделка пропущена. Пропусков: ${this.skipped}.`,
          );
          return;
        }
      }
      const entry = st.avgPrice ?? price;
      const slRub = e.slRub ?? null;
      let stopOrderId: string | null = null;
      if (slRub !== null) {
        stopOrderId = await t.postStopLoss({
          accountId: this.accountId, uid: this.uid, lots: this.cfg.lots,
          stopPrice: this.rounded(slRub),
          direction: e.side === 'BUY' ? 'SELL' : 'BUY',
        }).catch(err => {
          log.warn(`${this.cfg.ticker}: стоп-страховка не поставилась: ${errMsg(err)}`, undefined, 'afks');
          return null;
        });
      }
      this.pos = {
        virtRowId: e.rowId, side: e.side, lots: this.cfg.lots, qty,
        entryPrice: entry, virtEntry: e.priceRub, stopOrderId, openedAt: Date.now(),
      };
      const fee = entry * qty * config.afksFeeFrac;
      const risk = slRub !== null ? Math.abs(entry - slRub) * qty : null;
      await this.deps.notify(
        `🟢 ${this.cfg.ticker} вход (${config.afksLive === 'sandbox' ? 'ПЕСОЧНИЦА' : 'СЧЁТ'}): ${e.side} ${this.cfg.lots} лот × ${this.lotSize} = ${qty} шт @ ${entry.toFixed(3)}₽` +
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
      TickerMirror.sharedDayPnl += pnl;
      this.dayTrades += 1;
      const minutes = Math.round((Date.now() - pos.openedAt) / 60_000);
      this.pos = null;
      await this.deps.notify(
        `🔴 ${this.cfg.ticker} выход (${e.reason ?? '—'}): ${exit.toFixed(3)}₽ · виртуал @ ${e.priceRub.toFixed(3)} · ${minutes} мин` +
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
      ticker: this.cfg.ticker,
      member: this.cfg.memberKey,
      lots: this.cfg.lots,
      mode: config.afksLive,
      running: this.running,
      startError: this.startError,
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
