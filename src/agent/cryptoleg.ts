// Крипто-нога движка (эксперимент выходных, CRYPTO_WEEKEND=1).
//
// Работает ПАРАЛЛЕЛЬНО основному FX-контуру на том же MT5-счёте (metaapi, live):
// - котировки крипто-символа стримятся 24/7 (стратегия echo непрерывно учит
//   внутридневное расписание; при старте прогревается историей Dukascopy);
// - ВХОДЫ разрешены только пока FX закрыт (пт 20:45 → вс 21:15 UTC) — в будни
//   нога молчит и только наблюдает;
// - у ноги СВОЙ дневной лимит убытка: при достижении — закрыть свои позиции и
//   пауза до следующего дня UTC (глобальный kill-switch агента не трогаем,
//   чтобы эксперимент не мог остановить основной EUR/USD-тест);
// - сделки пишутся в ту же БД с symbol пресета (BTC_USD/ETH_USD) — панель,
//   ежечасные отчёты и обучение видят их автоматически.
//
// ЧЕСТНАЯ РАМКА: подтверждённого преимущества у крипто-ячеек нет
// (docs/CRYPTO-SWEEP-2026-07-31.md) — это сбор форвард-данных на демо.

import { config } from '../config';
import { errMsg, log } from '../logger';
import { CryptoPreset } from './params';
import { buildStrategy, Signal, TradingStrategy } from './strategy';
import { isFxWeekend, RiskManager } from './risk';
import { MetaApiAdapter } from '../broker/metaapi';
import { ScaledAdapter } from '../broker/scaled';
import { ClosedPosition, ExecutionAdapter, PIP, Quote, round5, sleep } from '../broker/types';
import type { TradeStore } from '../store';

export interface CryptoLegDeps {
  store: TradeStore;
  notify: (text: string) => Promise<void>;
}

interface LegPending {
  orderId: string;
  placedAt: number;
  ttlSec: number;
  side: 'BUY' | 'SELL';
  units: number;
  slPrice: number;
  tpPrice: number;
  reason: string;
  spreadAtSignal: number;
  volAtSignal: number;
}

export class CryptoLeg {
  private running = false;
  private abort: AbortController | null = null;
  private adapter: ExecutionAdapter | null = null;
  private strategy: TradingStrategy | null = null;
  private risk: RiskManager | null = null;
  private pendings: LegPending[] = [];
  private loopPromise: Promise<void> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private lastQuoteAt = 0;
  private lastQuote: Quote | null = null;
  private lastPendingCheckAt = 0;
  private lastReconcileAt = 0;
  private lastSnapshotAt = 0;
  private dayKey = '';
  private haltDay = '';
  private tradesToday = 0;
  private realizedToday = 0;
  private unrealizedOwn = 0;
  private warmupDays = 0;
  private lastError: string | null = null;

  constructor(private deps: CryptoLegDeps, private preset: CryptoPreset) {}

  isRunning(): boolean {
    return this.running;
  }

  mt5Symbol(): string {
    return config.mt5SymbolCrypto || this.preset.mt5Symbol;
  }

  async start(): Promise<void> {
    if (this.running) return;
    if (!config.metaapiToken || !config.metaapiAccountId) {
      throw new Error('крипто-нога требует METAAPI_TOKEN и METAAPI_ACCOUNT_ID');
    }
    const inner = new MetaApiAdapter({
      token: config.metaapiToken,
      accountId: config.metaapiAccountId,
      symbol: this.mt5Symbol(),
    });
    this.adapter = new ScaledAdapter(inner, {
      mt5Symbol: this.mt5Symbol(),
      scale: this.preset.priceScale,
      digits: this.preset.digits,
    });
    this.strategy = buildStrategy(this.preset.params);
    this.risk = new RiskManager(this.preset.params);
    this.pendings = [];
    this.dayKey = new Date().toISOString().slice(0, 10);
    this.tradesToday = await this.deps.store.countTradesToday('live', this.preset.symbol);
    this.realizedToday = await this.deps.store.realizedPnlToday('live', this.preset.symbol);
    this.unrealizedOwn = 0;
    this.lastError = null;
    this.lastQuoteAt = 0;
    this.running = true;

    if (this.preset.params.strategyType === 'echo') {
      await this.warmupFromHistory();
    }

    this.loopPromise = this.loop();
    this.watchdog = setInterval(() => this.checkWatchdog(), 10_000);
    log.success(
      `крипто-нога запущена: ${this.preset.symbol} (${this.mt5Symbol()}), ${this.preset.params.strategyType}/${this.preset.params.entryMode}, `
      + `входы только в FX-выходные, дневной лимит ${this.preset.params.maxDailyLossUsd}$`,
      undefined, 'crypto',
    );
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
    await this.cancelPendings();
    this.abort?.abort();
    if (this.loopPromise) {
      await this.loopPromise.catch(() => {});
      this.loopPromise = null;
    }
    await this.adapter?.shutdown?.().catch(() => {});
    this.adapter = null;
    log.info('крипто-нога остановлена', undefined, 'crypto');
  }

  /** Прогрев echo историей Dukascopy: 20-дневное расписание готово сразу. */
  private async warmupFromHistory(): Promise<void> {
    try {
      const { loadM1 } = await import('../backtest/data');
      const to = new Date();
      const from = new Date(Date.now() - 26 * 86400_000);
      const candles = await loadM1(this.preset.dukascopy, from, to);
      const strategy = this.strategy;
      if (!strategy || candles.length < 1440) {
        log.warn(`прогрев echo: мало истории (${candles.length} минуток) — холодный старт`, undefined, 'crypto');
        return;
      }
      for (const c of candles) {
        const mid = c.c / this.preset.priceScale;
        strategy.onQuote({ symbol: this.preset.symbol, bid: mid, ask: mid, time: new Date(c.t) });
      }
      this.warmupDays = Math.round((candles[candles.length - 1].t - candles[0].t) / 86400_000);
      log.success(`прогрев echo: ${candles.length} минуток (~${this.warmupDays} дней) из истории`, undefined, 'crypto');
    } catch (e) {
      log.warn(`прогрев echo не удался (${errMsg(e)}) — холодный старт, сигналы через ~5 дней`, undefined, 'crypto');
    }
  }

  private async loop(): Promise<void> {
    let backoff = 1000;
    while (this.running) {
      this.abort = new AbortController();
      try {
        const adapter = this.adapter;
        if (!adapter) break;
        for await (const q of adapter.streamQuotes(this.mt5Symbol(), this.abort.signal)) {
          if (!this.running) break;
          backoff = 1000;
          this.lastQuote = q;
          this.lastQuoteAt = Date.now();
          try {
            await this.onQuote(q);
          } catch (e) {
            log.error(`crypto onQuote: ${errMsg(e)}`, undefined, 'crypto');
          }
        }
        if (this.running) log.warn('крипто-стрим завершился, реконнект…', undefined, 'crypto');
      } catch (e) {
        if (this.running) {
          this.lastError = errMsg(e);
          log.warn(`крипто-стрим упал: ${this.lastError}`, undefined, 'crypto');
        }
      }
      if (this.running) {
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  }

  private checkWatchdog(): void {
    if (!this.running || !this.lastQuoteAt) return;
    // крипта тикает 24/7 — тишина дольше 90с значит залипший стрим
    if (Date.now() - this.lastQuoteAt > 90_000) {
      log.warn('крипто-вотчдог: нет котировок > 90с — реконнект', undefined, 'crypto');
      this.lastQuoteAt = Date.now();
      this.abort?.abort();
    }
  }

  private async rollDay(now: Date): Promise<void> {
    const key = now.toISOString().slice(0, 10);
    if (key === this.dayKey) return;
    this.dayKey = key;
    this.tradesToday = await this.deps.store.countTradesToday('live', this.preset.symbol);
    this.realizedToday = await this.deps.store.realizedPnlToday('live', this.preset.symbol);
  }

  private halted(): boolean {
    return this.haltDay === this.dayKey;
  }

  private async onQuote(q: Quote): Promise<void> {
    await this.rollDay(q.time);
    const t = Date.now();
    if (t - this.lastReconcileAt > 5_000) {
      this.lastReconcileAt = t;
      await this.reconcile();
    }
    // на FX-выходных основной движок молчит — снапшоты equity делает нога
    if (isFxWeekend(q.time) && t - this.lastSnapshotAt > 60_000) {
      this.lastSnapshotAt = t;
      await this.snapshot();
    }
    if (this.pendings.length && t - this.lastPendingCheckAt > 3_000) {
      this.lastPendingCheckAt = t;
      await this.processPendings();
    }

    const strategy = this.strategy;
    const risk = this.risk;
    if (!strategy || !risk || !this.running) return;

    // стратегия ест каждую котировку (echo учится и в будни), а входы — только
    // пока FX закрыт и дневной лимит ноги не выбран
    const sig = strategy.onQuote(q);
    if (!sig) return;
    if (!isFxWeekend(q.time) || this.halted()) return;

    const spreadPips = (q.ask - q.bid) / PIP;
    const own = await this.deps.store.listOpenTrades('live', this.preset.symbol);
    const verdict = risk.check({
      now: q.time,
      openCount: own.length + this.pendings.length,
      tradesToday: this.tradesToday,
      plToday: this.realizedToday + this.unrealizedOwn,
      spreadPips,
      newsBlackout: false,
      crypto: true,
    });
    if (!verdict.ok) {
      log.info(`крипто-сигнал (${sig.reason}) отклонён: ${verdict.reason}`, undefined, 'crypto');
      return;
    }
    if (this.preset.params.entryMode === 'limit' && this.adapter?.limitOrder) {
      await this.placeLimitEntry(sig, q, spreadPips);
    } else {
      await this.openMarket(sig, q, spreadPips);
    }
  }

  private async placeLimitEntry(sig: Signal, q: Quote, spreadPips: number): Promise<void> {
    const adapter = this.adapter;
    const strategy = this.strategy;
    if (!adapter?.limitOrder || !strategy) return;
    const p = this.preset.params;
    const price = round5(sig.side === 'BUY' ? q.bid - p.entryOffsetPips * PIP : q.ask + p.entryOffsetPips * PIP);
    const tpPrice = round5(sig.side === 'BUY' ? price + sig.tpPips * PIP : price - sig.tpPips * PIP);
    const slPrice = round5(sig.side === 'BUY' ? price - sig.slPips * PIP : price + sig.slPips * PIP);
    const { orderId } = await adapter.limitOrder({
      symbol: this.preset.symbol,
      side: sig.side,
      units: p.units,
      price,
      slPrice,
      tpPrice,
      ttlSec: p.entryTtlSec,
      tag: `fxc-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    });
    this.pendings.push({
      orderId,
      placedAt: Date.now(),
      ttlSec: p.entryTtlSec,
      side: sig.side,
      units: p.units,
      slPrice,
      tpPrice,
      reason: sig.reason,
      spreadAtSignal: spreadPips,
      volAtSignal: strategy.windowRangePips(),
    });
    log.info(`🧪 крипто: лимитный вход ${sig.side} ${p.units} @ ${price.toFixed(5)} (${sig.reason})`, undefined, 'crypto');
  }

  private async processPendings(): Promise<void> {
    const adapter = this.adapter;
    if (!adapter?.checkOrder) return;
    const keep: LegPending[] = [];
    for (const pe of this.pendings) {
      try {
        const expired = Date.now() - pe.placedAt > (pe.ttlSec + 10) * 1000;
        const check = await adapter.checkOrder(pe.orderId);
        if (check.state === 'FILLED') {
          this.tradesToday += 1;
          const trade = await this.deps.store.openTrade({
            mode: 'live',
            symbol: this.preset.symbol,
            side: pe.side,
            units: pe.units,
            entryPrice: check.fillPrice,
            slPrice: pe.slPrice,
            tpPrice: pe.tpPrice,
            openedAt: check.filledAt,
            costSpread: 0,
            costCommission: 0,
            brokerTradeId: check.brokerTradeId,
            spreadAtEntry: pe.spreadAtSignal,
            volAtEntry: pe.volAtSignal,
            hourUtc: check.filledAt.getUTCHours(),
            newsDistMin: null,
            paramsSnapshot: this.preset.params,
          });
          await this.deps.notify(
            `🧪📈 №${trade.id} ${pe.side} ${pe.units} ${this.preset.symbol} @ ${check.fillPrice.toFixed(5)} (крипто-эксперимент, лимитный вход)\n`
            + `TP ${pe.tpPrice.toFixed(5)} · SL ${pe.slPrice.toFixed(5)} · ${pe.reason}`,
          );
        } else if (check.state === 'GONE' || expired) {
          if (expired && check.state === 'PENDING') await adapter.cancelOrder?.(pe.orderId);
          log.info(`крипто: лимитный вход ${pe.orderId} не исполнился`, undefined, 'crypto');
        } else {
          keep.push(pe);
        }
      } catch (e) {
        log.warn(`crypto processPendings: ${errMsg(e)}`, undefined, 'crypto');
        keep.push(pe);
      }
    }
    this.pendings = keep;
  }

  private async openMarket(sig: Signal, q: Quote, spreadPips: number): Promise<void> {
    const adapter = this.adapter;
    const strategy = this.strategy;
    if (!adapter || !strategy) return;
    const p = this.preset.params;
    const entryRef = sig.side === 'BUY' ? q.ask : q.bid;
    const tpPrice = round5(sig.side === 'BUY' ? entryRef + sig.tpPips * PIP : entryRef - sig.tpPips * PIP);
    const slPrice = round5(sig.side === 'BUY' ? entryRef - sig.slPips * PIP : entryRef + sig.slPips * PIP);
    const res = await adapter.marketOrder({
      symbol: this.preset.symbol, side: sig.side, units: p.units, slPrice, tpPrice,
    });
    this.tradesToday += 1;
    const trade = await this.deps.store.openTrade({
      mode: 'live',
      symbol: this.preset.symbol,
      side: sig.side,
      units: p.units,
      entryPrice: res.fillPrice,
      slPrice,
      tpPrice,
      openedAt: res.filledAt,
      costSpread: (q.ask - q.bid) * p.units,
      costCommission: 0,
      brokerTradeId: res.brokerTradeId,
      spreadAtEntry: spreadPips,
      volAtEntry: strategy.windowRangePips(),
      hourUtc: q.time.getUTCHours(),
      newsDistMin: null,
      paramsSnapshot: p,
    });
    await this.deps.notify(
      `🧪📈 №${trade.id} ${sig.side} ${p.units} ${this.preset.symbol} @ ${res.fillPrice.toFixed(5)} (крипто-эксперимент)\n`
      + `TP ${tpPrice.toFixed(5)} · SL ${slPrice.toFixed(5)} · ${sig.reason}`,
    );
  }

  private async handleClose(c: ClosedPosition, rowId: number): Promise<void> {
    await this.deps.store.closeTradeById(rowId, {
      exitPrice: c.exitPrice,
      closedAt: c.closedAt,
      pnl: c.realizedPnl,
      closeReason: c.closeReason ?? 'RECONCILED',
    });
    this.realizedToday += c.realizedPnl;
    const emoji = c.realizedPnl >= 0 ? '✅' : '🔻';
    await this.deps.notify(
      `🧪${emoji} №${rowId} (${this.preset.symbol}) закрыта (${c.closeReason ?? 'RECONCILED'}): `
      + `${c.realizedPnl >= 0 ? '+' : ''}${c.realizedPnl.toFixed(2)}$\n`
      + `Крипто-нога за день: ${this.realizedToday >= 0 ? '+' : ''}${this.realizedToday.toFixed(2)}$, лимит −${this.preset.params.maxDailyLossUsd}$`,
    );
    await this.haltCheck();
  }

  private async reconcile(): Promise<void> {
    const adapter = this.adapter;
    if (!adapter) return;
    try {
      const [positions, openRows] = await Promise.all([
        adapter.listPositions(),
        this.deps.store.listOpenTrades('live', this.preset.symbol),
      ]);
      const live = new Set(positions.map(p => p.brokerTradeId));
      this.unrealizedOwn = positions
        .filter(p => p.symbol === this.mt5Symbol())
        .reduce((s, p) => s + (p.unrealizedPnl ?? 0), 0);
      for (const row of openRows) {
        if (!row.brokerTradeId || live.has(row.brokerTradeId)) continue;
        const closed = adapter.getClosedTrade ? await adapter.getClosedTrade(row.brokerTradeId) : null;
        if (closed) await this.handleClose(closed, row.id);
      }
    } catch (e) {
      log.warn(`crypto reconcile: ${errMsg(e)}`, undefined, 'crypto');
    }
  }

  private async snapshot(): Promise<void> {
    const adapter = this.adapter;
    if (!adapter) return;
    try {
      const a = await adapter.accountState();
      await this.deps.store.saveSnapshot('live', a.balance, a.equity, a.openPositionCount);
    } catch (e) {
      log.warn(`crypto snapshot: ${errMsg(e)}`, undefined, 'crypto');
    }
  }

  /** Дневной лимит ноги: закрыть своё и пауза до следующего дня UTC (без глобального kill). */
  private async haltCheck(): Promise<void> {
    if (!this.running || this.halted()) return;
    const pl = this.realizedToday + this.unrealizedOwn;
    if (pl > -this.preset.params.maxDailyLossUsd) return;
    this.haltDay = this.dayKey;
    await this.cancelPendings();
    const adapter = this.adapter;
    let closedNote = '';
    if (adapter) {
      try {
        const own = (await adapter.listPositions()).filter(p => p.symbol === this.mt5Symbol());
        let pnl = 0;
        let n = 0;
        for (const p of own) {
          const c = await adapter.closePosition(p.brokerTradeId);
          const row = await this.deps.store.findOpenByBrokerId('live', p.brokerTradeId);
          if (row) {
            await this.deps.store.closeTradeById(row.id, {
              exitPrice: c.exitPrice, closedAt: c.closedAt, pnl: c.realizedPnl, closeReason: 'KILL',
            });
          }
          this.realizedToday += c.realizedPnl;
          pnl += c.realizedPnl;
          n += 1;
        }
        if (n) closedNote = ` Закрыто позиций: ${n} (${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}$).`;
      } catch (e) {
        log.error(`crypto halt close: ${errMsg(e)}`, undefined, 'crypto');
      }
    }
    this.unrealizedOwn = 0;
    await this.deps.notify(
      `🧪🟠 Крипто-нога: дневной убыток ${pl.toFixed(2)}$ достиг лимита ${this.preset.params.maxDailyLossUsd}$.${closedNote}\n`
      + `Пауза до следующего дня UTC. Основной FX-контур НЕ затронут.`,
    );
  }

  private async cancelPendings(): Promise<void> {
    const adapter = this.adapter;
    if (adapter?.cancelOrder) {
      for (const pe of this.pendings) {
        await adapter.cancelOrder(pe.orderId).catch(() => {});
      }
    }
    this.pendings = [];
  }

  status() {
    return {
      enabled: true,
      preset: this.preset.key,
      symbol: this.preset.symbol,
      mt5Symbol: this.mt5Symbol(),
      strategy: `${this.preset.params.strategyType}/${this.preset.params.entryMode}`,
      running: this.running,
      entriesActive: this.running && isFxWeekend(new Date()) && !this.halted(),
      haltedToday: this.halted(),
      warmupDays: this.warmupDays,
      lastQuote: this.lastQuote,
      lastQuoteAgoSec: this.lastQuoteAt ? Math.round((Date.now() - this.lastQuoteAt) / 1000) : null,
      lastError: this.lastError,
      tradesToday: this.tradesToday,
      realizedToday: this.realizedToday,
      pendingEntries: this.pendings.length,
      maxDailyLossUsd: this.preset.params.maxDailyLossUsd,
    };
  }
}
