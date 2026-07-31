// Движок: поток котировок → стратегия → риск-ворота → ордер у брокера → БД → уведомления.
// Реконнект с backoff, вотчдог, reconcile TP/SL-закрытий, kill-switch, graceful stop.

import { config } from '../config';
import { errMsg, log } from '../logger';
import { AgentParams, clampParams } from './params';
import { MomentumStrategy, Signal } from './strategy';
import { isFxWeekend, RiskManager } from './risk';
import { SimAdapter } from '../broker/sim';
import { OandaAdapter } from '../broker/oanda';
import {
  AccountState, ClosedPosition, ExecutionAdapter, PIP, Quote, round5, Side, sleep,
} from '../broker/types';
import type { SettingsState, TradeStore } from '../store';

export interface EngineDeps {
  store: TradeStore;
  notify: (text: string) => Promise<void>;
  isNewsBlackout: (ts: Date, bufferMin: number) => boolean;
  newsDistanceMin: (ts: Date) => number | null;
}

export function fmtUsd(v: number): string {
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}$`;
}

export class AgentEngine {
  private running = false;
  private killing = false;
  private abort: AbortController | null = null;
  private adapter: ExecutionAdapter | null = null;
  private strategy: MomentumStrategy | null = null;
  private risk: RiskManager | null = null;
  private settings: SettingsState | null = null;
  private lastQuote: Quote | null = null;
  private lastQuoteAt = 0;
  private startedAt: Date | null = null;
  private lastError: string | null = null;
  private account: AccountState | null = null;
  private tradesToday = 0;
  private realizedToday = 0;
  private dayKey = '';
  private lastReconcileAt = 0;
  private lastSnapshotAt = 0;
  private loopPromise: Promise<void> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;

  constructor(private deps: EngineDeps) {}

  isRunning(): boolean {
    return this.running;
  }

  private buildAdapter(mode: 'sim' | 'live'): ExecutionAdapter {
    if (mode === 'sim') return new SimAdapter(config.simStartBalance);
    if (!config.oandaToken || !config.oandaAccountId) {
      throw new Error('Для live-режима нужны OANDA_API_TOKEN и OANDA_ACCOUNT_ID (OANDA_ENV=practice — демо-счёт, live — реальные деньги)');
    }
    return new OandaAdapter({ env: config.oandaEnv, token: config.oandaToken, accountId: config.oandaAccountId });
  }

  async start(): Promise<string> {
    if (this.running) return 'Агент уже запущен';
    const settings = await this.deps.store.getSettings();
    const adapter = this.buildAdapter(settings.mode);

    // sim-состояние не переживает рестарт: висящие «открытые» sim-сделки закрываем нулём
    if (settings.mode === 'sim') {
      const stale = await this.deps.store.listOpenTrades('sim');
      for (const t of stale) {
        await this.deps.store.closeTradeById(t.id, {
          exitPrice: t.entryPrice, closedAt: new Date(), pnl: 0, closeReason: 'RECONCILED',
        });
      }
      if (stale.length) log.warn(`закрыто ${stale.length} устаревших sim-сделок после рестарта`, undefined, 'engine');
    }

    this.settings = settings;
    this.adapter = adapter;
    this.strategy = new MomentumStrategy(settings.params);
    this.risk = new RiskManager(settings.params);
    this.dayKey = new Date().toISOString().slice(0, 10);
    this.tradesToday = await this.deps.store.countTradesToday(settings.mode);
    this.realizedToday = await this.deps.store.realizedPnlToday(settings.mode);
    this.lastError = null;
    this.lastQuote = null;
    this.lastQuoteAt = 0;
    this.account = null;
    this.running = true;
    this.startedAt = new Date();

    adapter.onPositionClosed?.(p => {
      void this.handleBrokerClose(p).catch(e => log.error(`handleBrokerClose: ${errMsg(e)}`, undefined, 'engine'));
    });

    await this.deps.store.saveSettings({ isRunning: true, killSwitchAt: null });
    this.loopPromise = this.loop();
    this.watchdog = setInterval(() => this.checkWatchdog(), 5000);

    const label = settings.mode === 'sim'
      ? 'sim (симулятор, без реальных денег)'
      : `live → OANDA ${config.oandaEnv}${config.oandaEnv === 'practice' ? ' (демо-счёт)' : ' (РЕАЛЬНЫЕ ДЕНЬГИ)'}`;
    log.success(`агент запущен: ${label}, ${settings.symbol}`, undefined, 'engine');
    if (isFxWeekend(new Date())) {
      return `▶️ Агент запущен: ${label}, ${settings.symbol}.\n⚠️ Сейчас выходные FX — входов не будет до воскресенья 21:15 UTC.`;
    }
    return `▶️ Агент запущен: ${label}, символ ${settings.symbol}`;
  }

  async stop(): Promise<string> {
    if (!this.running) return 'Агент уже остановлен';
    const s = this.settings;
    // в sim позиции живут только в памяти адаптера — закрываем по рынку перед стопом
    let closedNote = '';
    if (s?.mode === 'sim' && this.adapter) {
      const closed = await this.adapter.closeAll();
      let pnl = 0;
      for (const c of closed) pnl += await this.persistClose(c, 'MANUAL');
      if (closed.length) closedNote = ` Закрыто sim-позиций: ${closed.length} (${fmtUsd(pnl)}).`;
    }
    await this.stopInternal();
    await this.deps.store.saveSettings({ isRunning: false });
    let tail = '';
    if (s && s.mode === 'live') {
      const open = (await this.deps.store.listOpenTrades(s.mode)).length;
      if (open > 0) tail = ` Открытых позиций у брокера: ${open} — SL/TP стоят на его стороне; закрыть всё: /agent_kill.`;
    }
    log.info('агент остановлен', undefined, 'engine');
    return `⏸ Агент остановлен.${closedNote}${tail}`;
  }

  private async stopInternal(): Promise<void> {
    this.running = false;
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
    this.abort?.abort();
    if (this.loopPromise) {
      await this.loopPromise.catch(() => {});
      this.loopPromise = null;
    }
    this.adapter = null;
  }

  /** Мягкая пауза при выключении процесса: НЕ трогает isRunning в БД,
   *  чтобы после рестарта/деплоя агент возобновился сам. */
  async suspend(): Promise<void> {
    if (!this.running) return;
    await this.stopInternal();
    log.info('агент приостановлен (shutdown процесса); возобновится на старте', undefined, 'engine');
  }

  /** Аварийное закрытие всего + стоп. Работает и при остановленном движке (live). */
  async kill(reason: string): Promise<string> {
    if (this.killing) return 'kill уже выполняется';
    this.killing = true;
    try {
      log.error(`KILL-SWITCH: ${reason}`, undefined, 'engine');
      const settings = this.settings ?? await this.deps.store.getSettings();
      const adapter = this.adapter ?? this.buildAdapter(settings.mode);
      const closed = await adapter.closeAll();
      let pnl = 0;
      for (const c of closed) pnl += await this.persistClose(c, 'KILL');
      if (this.running) await this.stopInternal();
      await this.deps.store.saveSettings({ isRunning: false, killSwitchAt: new Date() });
      const text = `🚨 KILL-SWITCH: ${reason}\nЗакрыто позиций: ${closed.length} (${fmtUsd(pnl)}). Агент остановлен — перезапуск вручную: /agent_start`;
      await this.deps.notify(text);
      return text;
    } finally {
      this.killing = false;
    }
  }

  private async persistClose(c: ClosedPosition, fallbackReason: string): Promise<number> {
    const settings = this.settings ?? await this.deps.store.getSettings();
    const row = await this.deps.store.findOpenByBrokerId(settings.mode, c.brokerTradeId);
    if (!row) return 0;
    await this.deps.store.closeTradeById(row.id, {
      exitPrice: c.exitPrice,
      closedAt: c.closedAt,
      pnl: c.realizedPnl,
      closeReason: c.closeReason && c.closeReason !== 'MANUAL' ? c.closeReason : fallbackReason,
    });
    this.realizedToday += c.realizedPnl;
    return c.realizedPnl;
  }

  private async loop(): Promise<void> {
    let backoff = 1000;
    while (this.running) {
      this.abort = new AbortController();
      try {
        const adapter = this.adapter;
        const settings = this.settings;
        if (!adapter || !settings) break;
        for await (const q of adapter.streamQuotes(settings.symbol, this.abort.signal)) {
          if (!this.running) break;
          backoff = 1000;
          this.lastQuote = q;
          this.lastQuoteAt = Date.now();
          try {
            await this.onQuote(q);
          } catch (e) {
            log.error(`onQuote: ${errMsg(e)}`, undefined, 'engine');
          }
        }
        if (this.running) log.warn('поток котировок завершился, реконнект…', undefined, 'engine');
      } catch (e) {
        if (this.running) {
          this.lastError = errMsg(e);
          log.warn(`поток котировок упал: ${this.lastError}`, undefined, 'engine');
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
    if (isFxWeekend(new Date())) return; // на выходных тишина в стриме — норма
    if (Date.now() - this.lastQuoteAt > 20_000) {
      log.warn('вотчдог: нет котировок > 20с — принудительный реконнект', undefined, 'engine');
      this.lastQuoteAt = Date.now();
      this.abort?.abort();
    }
  }

  private async rollDay(now: Date): Promise<void> {
    const key = now.toISOString().slice(0, 10);
    if (key === this.dayKey) return;
    this.dayKey = key;
    const settings = this.settings;
    if (!settings) return;
    this.tradesToday = await this.deps.store.countTradesToday(settings.mode);
    this.realizedToday = await this.deps.store.realizedPnlToday(settings.mode);
    log.info(`новый торговый день ${key} (UTC)`, undefined, 'engine');
  }

  private async onQuote(q: Quote): Promise<void> {
    await this.rollDay(q.time);
    const t = Date.now();
    if (t - this.lastReconcileAt > 5_000) {
      this.lastReconcileAt = t;
      await this.reconcile();
    }
    if (t - this.lastSnapshotAt > 60_000) {
      this.lastSnapshotAt = t;
      await this.snapshot();
    }

    const strategy = this.strategy;
    const risk = this.risk;
    const settings = this.settings;
    if (!strategy || !risk || !settings || !this.running) return;

    const sig = strategy.onQuote(q);
    if (!sig) return;

    const spreadPips = (q.ask - q.bid) / PIP;
    const open = await this.deps.store.listOpenTrades(settings.mode);
    const unrealized = this.account ? this.account.equity - this.account.balance : 0;
    const verdict = risk.check({
      now: q.time,
      openCount: open.length,
      tradesToday: this.tradesToday,
      plToday: this.realizedToday + unrealized,
      spreadPips,
      newsBlackout: this.deps.isNewsBlackout(q.time, settings.params.newsBufferMin),
    });
    if (!verdict.ok) {
      log.info(`сигнал (${sig.reason}) отклонён: ${verdict.reason}`, undefined, 'engine');
      return;
    }
    await this.openPosition(sig, q, spreadPips);
  }

  private async openPosition(sig: Signal, q: Quote, spreadPips: number): Promise<void> {
    const settings = this.settings;
    const adapter = this.adapter;
    const strategy = this.strategy;
    if (!settings || !adapter || !strategy) return;

    const entryRef = sig.side === 'BUY' ? q.ask : q.bid;
    const tpPrice = round5(sig.side === 'BUY' ? entryRef + sig.tpPips * PIP : entryRef - sig.tpPips * PIP);
    const slPrice = round5(sig.side === 'BUY' ? entryRef - sig.slPips * PIP : entryRef + sig.slPips * PIP);

    const res = await adapter.marketOrder({
      symbol: settings.symbol,
      side: sig.side,
      units: settings.params.units,
      slPrice,
      tpPrice,
    });
    this.tradesToday += 1;

    const trade = await this.deps.store.openTrade({
      mode: settings.mode,
      symbol: settings.symbol,
      side: sig.side,
      units: settings.params.units,
      entryPrice: res.fillPrice,
      slPrice,
      tpPrice,
      openedAt: res.filledAt,
      costSpread: (q.ask - q.bid) * settings.params.units,
      costCommission: 0,
      brokerTradeId: res.brokerTradeId,
      spreadAtEntry: spreadPips,
      volAtEntry: strategy.windowRangePips(),
      hourUtc: q.time.getUTCHours(),
      newsDistMin: this.deps.newsDistanceMin(q.time),
      paramsSnapshot: settings.params,
    });

    const text = `📈 №${trade.id} ${sig.side} ${settings.params.units} ${settings.symbol} @ ${res.fillPrice.toFixed(5)}\n`
      + `TP ${tpPrice.toFixed(5)} · SL ${slPrice.toFixed(5)} · спред ${spreadPips.toFixed(1)}p (≈${((q.ask - q.bid) * settings.params.units).toFixed(2)}$)\n`
      + `${sig.reason} · сделка ${this.tradesToday}/${settings.params.maxTradesPerDay} за день`;
    log.success(text.replaceAll('\n', ' | '), undefined, 'engine');
    await this.deps.notify(text);
  }

  private async handleBrokerClose(p: ClosedPosition): Promise<void> {
    const settings = this.settings;
    if (!settings) return;
    const row = await this.deps.store.findOpenByBrokerId(settings.mode, p.brokerTradeId);
    if (!row) return;
    await this.deps.store.closeTradeById(row.id, {
      exitPrice: p.exitPrice,
      closedAt: p.closedAt,
      pnl: p.realizedPnl,
      closeReason: p.closeReason ?? 'RECONCILED',
    });
    this.realizedToday += p.realizedPnl;
    const emoji = p.realizedPnl >= 0 ? '✅' : '🔻';
    await this.deps.notify(
      `${emoji} №${row.id} закрыта (${p.closeReason ?? 'RECONCILED'}): ${fmtUsd(p.realizedPnl)} @ ${p.exitPrice.toFixed(5)}\n`
      + `За день: ${fmtUsd(this.realizedToday)}, сделок ${this.tradesToday}`,
    );
    await this.killCheckNow();
  }

  private async reconcile(): Promise<void> {
    const settings = this.settings;
    const adapter = this.adapter;
    if (!settings || !adapter) return;
    try {
      const [positions, openRows] = await Promise.all([
        adapter.listPositions(),
        this.deps.store.listOpenTrades(settings.mode),
      ]);
      const live = new Set(positions.map(p => p.brokerTradeId));
      for (const row of openRows) {
        if (!row.brokerTradeId || live.has(row.brokerTradeId)) continue;
        const closed = adapter.getClosedTrade ? await adapter.getClosedTrade(row.brokerTradeId) : null;
        if (closed) await this.handleBrokerClose(closed);
      }
    } catch (e) {
      log.warn(`reconcile: ${errMsg(e)}`, undefined, 'engine');
    }
  }

  private async snapshot(): Promise<void> {
    const settings = this.settings;
    const adapter = this.adapter;
    if (!settings || !adapter) return;
    try {
      this.account = await adapter.accountState();
      await this.deps.store.saveSnapshot(
        settings.mode, this.account.balance, this.account.equity, this.account.openPositionCount,
      );
      await this.killCheckNow();
    } catch (e) {
      log.warn(`snapshot: ${errMsg(e)}`, undefined, 'engine');
    }
  }

  private async killCheckNow(): Promise<void> {
    if (!this.running || this.killing || !this.risk || !this.settings) return;
    const unrealized = this.account ? this.account.equity - this.account.balance : 0;
    const pl = this.realizedToday + unrealized;
    if (this.risk.shouldKill(pl)) {
      await this.kill(`дневной убыток ${pl.toFixed(2)}$ достиг лимита ${this.settings.params.maxDailyLossUsd}$`);
    }
  }

  /** Смена параметров на лету (в пределах HARD_LIMITS). */
  async applyParams(patch: Partial<AgentParams>): Promise<AgentParams> {
    const settings = this.settings ?? await this.deps.store.getSettings();
    const params = clampParams({ ...settings.params, ...patch });
    await this.deps.store.saveSettings({ params });
    if (this.settings) this.settings.params = params;
    this.strategy?.updateParams(params);
    this.risk?.updateParams(params);
    log.info(`параметры обновлены: ${JSON.stringify(patch)}`, undefined, 'engine');
    return params;
  }

  async setMode(mode: 'sim' | 'live'): Promise<string> {
    if (this.running) return '⚠️ Сначала остановите агента: /agent_stop';
    this.buildAdapter(mode); // валидация конфигурации (для live — наличие ключей)
    await this.deps.store.saveSettings({ mode });
    this.settings = await this.deps.store.getSettings();
    return mode === 'sim'
      ? '✅ Режим: sim (симулятор)'
      : `✅ Режим: live → OANDA ${config.oandaEnv}${config.oandaEnv === 'practice' ? ' (демо-счёт)' : ' (⚠️ РЕАЛЬНЫЕ ДЕНЬГИ)'}`;
  }

  /** Тестовый ордер с текущими TP/SL — для проверки связки с брокером. */
  async testOrder(side: Side): Promise<string> {
    if (!this.running || !this.lastQuote) return '⚠️ Агент должен быть запущен и получать котировки';
    const q = this.lastQuote;
    const settings = this.settings;
    if (!settings) return '⚠️ Нет настроек';
    await this.openPosition(
      { side, tpPips: settings.params.tpPips, slPips: settings.params.slPips, reason: 'тестовый ордер' },
      q,
      (q.ask - q.bid) / PIP,
    );
    return '✅ Тестовый ордер отправлен';
  }

  status() {
    return {
      running: this.running,
      mode: this.settings?.mode ?? null,
      symbol: this.settings?.symbol ?? null,
      oandaEnv: config.oandaEnv,
      startedAt: this.startedAt,
      lastQuote: this.lastQuote,
      lastQuoteAgoSec: this.lastQuoteAt ? Math.round((Date.now() - this.lastQuoteAt) / 1000) : null,
      lastError: this.lastError,
      account: this.account,
      tradesToday: this.tradesToday,
      realizedToday: this.realizedToday,
      fxWeekend: isFxWeekend(new Date()),
      params: this.settings?.params ?? null,
      killSwitchAt: this.settings?.killSwitchAt ?? null,
    };
  }
}
