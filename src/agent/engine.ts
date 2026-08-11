// Движок: поток котировок → стратегия → риск-ворота → ордер у брокера → БД → уведомления.
// Реконнект с backoff, вотчдог, reconcile TP/SL-закрытий, kill-switch, graceful stop.

import { config } from '../config';
import { errMsg, log } from '../logger';
import { netMeter, readNetTotals, tcpCensus, topHosts } from '../netmeter';
import { AgentParams, clampParams, CRYPTO_PRESETS, ENSEMBLE_MEMBERS, ENSEMBLE_MEMBERS_BTC } from './params';
import { buildStrategy, Signal, TradingStrategy } from './strategy';
import { CryptoLeg } from './cryptoleg';
import { EnsembleLeg } from './ensemble';
import { MakerLeg } from './makerleg';
import { MarketsLeg } from './marketsleg';
import { MoexLeg } from './moexleg';
import { isFxWeekend, RiskManager } from './risk';
import { SimAdapter } from '../broker/sim';
import { OandaAdapter } from '../broker/oanda';
import { MetaApiAdapter } from '../broker/metaapi';
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

interface PendingEntry {
  orderId: string;
  placedAt: number;
  ttlSec: number;
  side: Side;
  units: number;
  limitPrice: number;
  slPrice: number;
  tpPrice: number;
  reason: string;
  spreadAtSignal: number;
  volAtSignal: number;
  newsDist: number | null;
}

export class AgentEngine {
  private running = false;
  private killing = false;
  private abort: AbortController | null = null;
  private adapter: ExecutionAdapter | null = null;
  private strategy: TradingStrategy | null = null;
  private risk: RiskManager | null = null;
  private pendingEntries: PendingEntry[] = [];
  private lastPendingCheckAt = 0;
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
  private cryptoLeg: CryptoLeg | null = null;
  private makerLeg: MakerLeg | null = null;
  private ensembleLeg: EnsembleLeg | null = null;
  private btcEnsemble: EnsembleLeg | null = null;
  private marketsLeg: MarketsLeg | null = null;
  private moexLeg: MoexLeg | null = null;

  constructor(private deps: EngineDeps) {}

  isRunning(): boolean {
    return this.running;
  }

  private buildAdapter(mode: 'sim' | 'live'): ExecutionAdapter {
    if (mode === 'sim') return new SimAdapter(config.simStartBalance);
    if (config.broker === 'metaapi') {
      if (!config.metaapiToken || !config.metaapiAccountId) {
        throw new Error('Для live через MetaApi нужны METAAPI_TOKEN и METAAPI_ACCOUNT_ID (и MT5_SYMBOL, у Exness обычно EURUSDm)');
      }
      return new MetaApiAdapter({
        token: config.metaapiToken,
        accountId: config.metaapiAccountId,
        symbol: config.mt5Symbol,
      });
    }
    if (!config.oandaToken || !config.oandaAccountId) {
      throw new Error('Для live-режима нужны OANDA_API_TOKEN и OANDA_ACCOUNT_ID (OANDA_ENV=practice — демо-счёт, live — реальные деньги)');
    }
    return new OandaAdapter({ env: config.oandaEnv, token: config.oandaToken, accountId: config.oandaAccountId });
  }

  private liveLabel(): string {
    return config.broker === 'metaapi'
      ? `live → MT5/MetaApi (символ ${config.mt5Symbol}; демо- или реальный счёт задан в MetaApi)`
      : `live → OANDA ${config.oandaEnv}${config.oandaEnv === 'practice' ? ' (демо-счёт)' : ' (РЕАЛЬНЫЕ ДЕНЬГИ)'}`;
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
    this.strategy = buildStrategy(settings.params);
    this.risk = new RiskManager(settings.params);
    this.pendingEntries = [];
    this.dayKey = new Date().toISOString().slice(0, 10);
    this.tradesToday = await this.deps.store.countTradesToday(settings.mode, settings.symbol);
    this.realizedToday = await this.deps.store.realizedPnlToday(settings.mode, settings.symbol);
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
      : this.liveLabel();
    log.success(
      `агент запущен: ${label}, ${settings.symbol}, стратегия ${settings.params.strategyType}, вход ${settings.params.entryMode}`,
      undefined, 'engine',
    );

    // Вотермарк простоя: последний РАЗРЫВ в снапшотах >10 мин (суспенд/сбой) →
    // виртуальные ноги проигрывают пропуск по истории (сделки-BF). Разрыв берём
    // только свежий (конец ≤20 мин назад): это либо «лежали до сейчас», либо
    // цепочка «Render поднял старый билд → через минуты накатился новый»;
    // старые разрывы не трогаем — поверх уже наросли живые данные.
    let gapStart: Date | null = null;
    try {
      const gap = await this.deps.store.recentSnapshotGap();
      if (gap && Date.now() - gap.end.getTime() <= 20 * 60_000) {
        gapStart = gap.start;
        log.warn(
          `обнаружен простой ${gap.start.toISOString()} → ${gap.end.toISOString()} (${Math.round((gap.end.getTime() - gap.start.getTime()) / 60_000)} мин) — виртуальные ноги догонят его по истории`,
          undefined, 'engine',
        );
      } else if (gap) {
        log.info(`разрыв снапшотов ${gap.start.toISOString()} → ${gap.end.toISOString()} слишком давний — догонку не запускаю`, undefined, 'engine');
      }
    } catch (e) {
      log.warn(`вотермарк простоя: ${errMsg(e)}`, undefined, 'engine');
    }

    let cryptoNote = '';
    if (config.cryptoWeekend) {
      if (settings.mode === 'live' && config.broker === 'metaapi') {
        try {
          // крипто-ансамбль питается котировками крипто-ноги (24/7, включая выходные)
          if (config.ensemble) {
            this.btcEnsemble = new EnsembleLeg(
              { store: this.deps.store, isNewsBlackout: this.deps.isNewsBlackout },
              { baseSymbol: 'BTC_USD', crypto: true, warmup: { instrument: 'btcusd', scale: 100_000 } },
              ENSEMBLE_MEMBERS_BTC,
            );
            await this.btcEnsemble.start(gapStart);
          }
          const btcEns = this.btcEnsemble;
          this.cryptoLeg = new CryptoLeg(
            {
              store: this.deps.store,
              notify: this.deps.notify,
              tapQuote: btcEns ? q => btcEns.onQuote(q) : undefined,
            },
            CRYPTO_PRESETS[config.cryptoPreset],
          );
          await this.cryptoLeg.start();
          const st = this.cryptoLeg.status();
          cryptoNote = `\n🧪 Крипто-эксперимент: ${st.symbol} (${st.mt5Symbol}), ${st.strategy} — входы только пока FX закрыт, дневной лимит ${st.maxDailyLossUsd}$. Преимущество бэктестом НЕ подтверждено — сбор форвард-данных на демо.`;
          if (this.btcEnsemble) cryptoNote += '\n🎼 Крипто-ансамбль: 5 виртуальных стратегий на BTC-стриме, 24/7 (в т.ч. выходные).';
        } catch (e) {
          this.cryptoLeg = null;
          this.btcEnsemble?.stop();
          this.btcEnsemble = null;
          cryptoNote = `\n⚠️ Крипто-эксперимент не запустился: ${errMsg(e)}`;
          log.error(`крипто-нога не запустилась: ${errMsg(e)}`, undefined, 'crypto');
        }
      } else {
        cryptoNote = '\nℹ️ CRYPTO_WEEKEND=1 задан, но крипто-нога работает только в live-режиме с BROKER=metaapi.';
      }
    }

    if (config.ensemble && settings.mode === 'live') {
      try {
        this.ensembleLeg = new EnsembleLeg({ store: this.deps.store, isNewsBlackout: this.deps.isNewsBlackout });
        await this.ensembleLeg.start(gapStart);
        cryptoNote += '\n🎼 Ансамбль: 5 виртуальных стратегий на живых котировках (деньги не задействованы; /agent_ensemble).';
      } catch (e) {
        this.ensembleLeg = null;
        cryptoNote += `\n⚠️ Ансамбль не запустился: ${errMsg(e)}`;
        log.error(`ансамбль не запустился: ${errMsg(e)}`, undefined, 'ensemble');
      }
    }

    if (config.ensemble && config.markets && settings.mode === 'live'
      && config.broker === 'metaapi' && config.metaapiToken && config.metaapiAccountId) {
      try {
        this.marketsLeg = new MarketsLeg({ store: this.deps.store, isNewsBlackout: this.deps.isNewsBlackout });
        await this.marketsLeg.start(gapStart);
        cryptoNote += '\n🌍 Мультирынок: золото, нефть, GBPJPY, S&P500 — 5 победителей свипа торгуют виртуально (/agent_ensemble).';
      } catch (e) {
        this.marketsLeg = null;
        cryptoNote += `\n⚠️ Мультирыночная нога не запустилась: ${errMsg(e)}`;
        log.error(`мультирыночная нога не запустилась: ${errMsg(e)}`, undefined, 'markets');
      }
    }

    if (config.makerTestnet) {
      if (config.binanceTestnetKey && config.binanceTestnetSecret) {
        try {
          this.makerLeg = new MakerLeg({ store: this.deps.store, notify: this.deps.notify });
          await this.makerLeg.start();
          const ms = this.makerLeg.status();
          cryptoNote += `\n⚗️ Мейкер-тестнет: Binance Futures testnet, ${ms.symbol}, post-only страддл, qty ${ms.qtyBtc} BTC — деньги фейковые, дневной лимит ${ms.maxDailyLossUsd}$.`;
        } catch (e) {
          this.makerLeg = null;
          cryptoNote += `\n⚠️ Мейкер-тестнет не запустился: ${errMsg(e)}`;
          log.error(`мейкер-нога не запустилась: ${errMsg(e)}`, undefined, 'maker');
        }
      } else {
        cryptoNote += '\nℹ️ MAKER_TESTNET=1 задан, но нет BINANCE_TESTNET_KEY/BINANCE_TESTNET_SECRET.';
      }
    } else if (config.binanceTestnetKey && config.binanceTestnetSecret) {
      // жанр закрыт (03.08.2026) — одноразовая подчистка хвостов на тестнете:
      // снять висящие котировки, закрыть остаточный инвентарь. Идемпотентно.
      try {
        const { BinanceFuturesClient } = await import('../broker/binancef');
        const client = new BinanceFuturesClient(config.binanceTestnetKey, config.binanceTestnetSecret);
        await client.cancelAll(config.binanceSymbol);
        const pos = await client.position(config.binanceSymbol);
        if (pos.amt !== 0) {
          await client.marketClose(config.binanceSymbol, pos.amt);
          cryptoNote += `\n⚗️ Мейкер выключен (жанр закрыт): остаточный инвентарь ${pos.amt} BTC закрыт по рынку, котировки сняты.`;
          log.warn(`мейкер-ликвидатор: закрыт остаточный инвентарь ${pos.amt} BTC`, undefined, 'maker');
        }
      } catch (e) {
        log.warn(`мейкер-ликвидатор: ${errMsg(e)}`, undefined, 'maker');
      }
    }

    if (config.tinkoffToken && settings.mode === 'live') {
      try {
        this.moexLeg = new MoexLeg({ store: this.deps.store, isNewsBlackout: this.deps.isNewsBlackout });
        await this.moexLeg.start(gapStart);
        cryptoNote += '\n🇷🇺 MOEX-нога: TATN, GAZP, ROSN — виртуально по маркетдате T-Invest (read-only, комиссия 0.1%/круг в модели).';
      } catch (e) {
        this.moexLeg = null;
        cryptoNote += `\n⚠️ MOEX-нога не запустилась: ${errMsg(e)}`;
        log.error(`MOEX-нога не запустилась: ${errMsg(e)}`, undefined, 'moex');
      }
    }

    if (isFxWeekend(new Date())) {
      return `▶️ Агент запущен: ${label}, ${settings.symbol}.\n⚠️ Сейчас выходные FX — входов не будет до воскресенья 21:15 UTC.${cryptoNote}`;
    }
    return `▶️ Агент запущен: ${label}, символ ${settings.symbol}${cryptoNote}`;
  }

  async stop(): Promise<string> {
    if (!this.running) return 'Агент уже остановлен';
    const s = this.settings;
    await this.stopLegs();
    await this.cancelAllPending();
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
      const open = (await this.deps.store.listOpenTrades(s.mode)).length; // все символы, включая крипто-ногу
      if (open > 0) tail = ` Открытых позиций у брокера: ${open} — SL/TP стоят на его стороне; закрыть всё: /agent_kill.`;
    }
    log.info('агент остановлен', undefined, 'engine');
    return `⏸ Агент остановлен.${closedNote}${tail}`;
  }

  /** Остановить экспериментальные ноги (крипто-уикенд, мейкер-тестнет, ансамбль). */
  private async stopLegs(): Promise<void> {
    if (this.cryptoLeg) {
      await this.cryptoLeg.stop().catch(e => log.warn(`остановка крипто-ноги: ${errMsg(e)}`, undefined, 'crypto'));
      this.cryptoLeg = null;
    }
    if (this.makerLeg) {
      await this.makerLeg.stop().catch(e => log.warn(`остановка мейкер-ноги: ${errMsg(e)}`, undefined, 'maker'));
      this.makerLeg = null;
    }
    if (this.ensembleLeg) {
      this.ensembleLeg.stop();
      this.ensembleLeg = null;
    }
    if (this.btcEnsemble) {
      this.btcEnsemble.stop();
      this.btcEnsemble = null;
    }
    if (this.marketsLeg) {
      await this.marketsLeg.stop().catch(e => log.warn(`остановка мультирыночной ноги: ${errMsg(e)}`, undefined, 'markets'));
      this.marketsLeg = null;
    }
    if (this.moexLeg) {
      await this.moexLeg.stop().catch(e => log.warn(`остановка MOEX-ноги: ${errMsg(e)}`, undefined, 'moex'));
      this.moexLeg = null;
    }
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
    await this.stopLegs();
    await this.stopInternal();
    log.info('агент приостановлен (shutdown процесса); возобновится на старте', undefined, 'engine');
  }

  /** Аварийное закрытие всего + стоп. Работает и при остановленном движке (live). */
  async kill(reason: string): Promise<string> {
    if (this.killing) return 'kill уже выполняется';
    this.killing = true;
    try {
      log.error(`KILL-SWITCH: ${reason}`, undefined, 'engine');
      await this.stopLegs(); // отменит и лимитки ног; позиции крипто-ноги закроет closeAll ниже
      await this.cancelAllPending();
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
    this.tradesToday = await this.deps.store.countTradesToday(settings.mode, settings.symbol);
    this.realizedToday = await this.deps.store.realizedPnlToday(settings.mode, settings.symbol);
    log.info(`новый торговый день ${key} (UTC)`, undefined, 'engine');
  }

  private async onQuote(q: Quote): Promise<void> {
    // виртуальный ансамбль ест каждый живой тик (ошибки не роняют основной цикл)
    if (this.ensembleLeg) {
      await this.ensembleLeg.onQuote(q).catch(e => log.warn(`ансамбль onQuote: ${errMsg(e)}`, undefined, 'ensemble'));
    }
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
    if (this.pendingEntries.length && t - this.lastPendingCheckAt > 3_000) {
      this.lastPendingCheckAt = t;
      await this.processPendingEntries();
    }

    const strategy = this.strategy;
    const risk = this.risk;
    const settings = this.settings;
    if (!strategy || !risk || !settings || !this.running) return;

    const sig = strategy.onQuote(q);
    if (!sig) return;

    const spreadPips = (q.ask - q.bid) / PIP;
    const open = await this.deps.store.listOpenTrades(settings.mode, settings.symbol);
    const unrealized = this.account ? this.account.equity - this.account.balance : 0;
    const verdict = risk.check({
      now: q.time,
      openCount: open.length + this.pendingEntries.length, // отложенные входы резервируют слот
      tradesToday: this.tradesToday,
      plToday: this.realizedToday + unrealized,
      spreadPips,
      newsBlackout: this.deps.isNewsBlackout(q.time, settings.params.newsBufferMin),
    });
    if (!verdict.ok) {
      log.info(`сигнал (${sig.reason}) отклонён: ${verdict.reason}`, undefined, 'engine');
      return;
    }
    if (settings.params.entryMode !== 'market' && this.adapter?.limitOrder) {
      // ladder вживую пока исполняется одиночной лимиткой (полная лестница — в бэктесте)
      if (sig.both) {
        // страддл: обе стороны сразу
        await this.placeLimitEntry({ ...sig, side: 'BUY' }, q, spreadPips);
        await this.placeLimitEntry({ ...sig, side: 'SELL' }, q, spreadPips);
      } else {
        await this.placeLimitEntry(sig, q, spreadPips);
      }
    } else if (sig.both) {
      log.info('страддл требует лимитных ордеров — market-режим пропущен', undefined, 'engine');
    } else {
      await this.openPosition(sig, q, spreadPips);
    }
  }

  /** Пассивный вход: лимитка на своей стороне спреда — издержку спреда не платим. */
  private async placeLimitEntry(sig: Signal, q: Quote, spreadPips: number): Promise<void> {
    const settings = this.settings;
    const adapter = this.adapter;
    const strategy = this.strategy;
    if (!settings || !adapter?.limitOrder || !strategy) return;
    const p = settings.params;
    const price = round5(sig.side === 'BUY' ? q.bid - p.entryOffsetPips * PIP : q.ask + p.entryOffsetPips * PIP);
    const tpPrice = round5(sig.side === 'BUY' ? price + sig.tpPips * PIP : price - sig.tpPips * PIP);
    const slPrice = round5(sig.side === 'BUY' ? price - sig.slPips * PIP : price + sig.slPips * PIP);
    const tag = `fxa-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const { orderId } = await adapter.limitOrder({
      symbol: settings.symbol,
      side: sig.side,
      units: p.units,
      price,
      slPrice,
      tpPrice,
      ttlSec: p.entryTtlSec,
      tag,
    });
    this.pendingEntries.push({
      orderId,
      placedAt: Date.now(),
      ttlSec: p.entryTtlSec,
      side: sig.side,
      units: p.units,
      limitPrice: price,
      slPrice,
      tpPrice,
      reason: sig.reason,
      spreadAtSignal: spreadPips,
      volAtSignal: strategy.windowRangePips(),
      newsDist: this.deps.newsDistanceMin(q.time),
    });
    log.info(`⏳ лимитный вход ${sig.side} ${p.units} @ ${price.toFixed(5)} (TTL ${p.entryTtlSec}с, ${sig.reason})`, undefined, 'engine');
  }

  private async processPendingEntries(): Promise<void> {
    const settings = this.settings;
    const adapter = this.adapter;
    if (!settings || !adapter?.checkOrder) return;
    const keep: PendingEntry[] = [];
    for (const pe of this.pendingEntries) {
      try {
        const expired = Date.now() - pe.placedAt > (pe.ttlSec + 10) * 1000;
        const check = await adapter.checkOrder(pe.orderId);
        if (check.state === 'FILLED') {
          this.tradesToday += 1;
          const trade = await this.deps.store.openTrade({
            mode: settings.mode,
            symbol: settings.symbol,
            side: pe.side,
            units: pe.units,
            entryPrice: check.fillPrice,
            slPrice: pe.slPrice,
            tpPrice: pe.tpPrice,
            openedAt: check.filledAt,
            costSpread: 0, // пассивный вход — спред не платили
            costCommission: 0,
            brokerTradeId: check.brokerTradeId,
            spreadAtEntry: pe.spreadAtSignal,
            volAtEntry: pe.volAtSignal,
            hourUtc: check.filledAt.getUTCHours(),
            newsDistMin: pe.newsDist,
            paramsSnapshot: settings.params,
          });
          await this.deps.notify(
            `📈 №${trade.id} ${pe.side} ${pe.units} ${settings.symbol} @ ${check.fillPrice.toFixed(5)} (лимитный вход, спред не платили)\n`
            + `TP ${pe.tpPrice.toFixed(5)} · SL ${pe.slPrice.toFixed(5)} · ${pe.reason}`,
          );
        } else if (check.state === 'GONE' || expired) {
          if (expired && check.state === 'PENDING') await adapter.cancelOrder?.(pe.orderId);
          log.info(`лимитный вход ${pe.orderId} не исполнился (${check.state === 'GONE' ? 'отменён/истёк' : 'TTL'})`, undefined, 'engine');
        } else {
          keep.push(pe);
        }
      } catch (e) {
        log.warn(`processPendingEntries: ${errMsg(e)}`, undefined, 'engine');
        keep.push(pe);
      }
    }
    this.pendingEntries = keep;
  }

  private async cancelAllPending(): Promise<void> {
    const adapter = this.adapter;
    if (adapter?.cancelOrder) {
      for (const pe of this.pendingEntries) {
        await adapter.cancelOrder(pe.orderId).catch(() => {});
      }
    }
    this.pendingEntries = [];
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
        this.deps.store.listOpenTrades(settings.mode, settings.symbol), // крипто-ногу реконсилирует она сама
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

  // сетевой метр: суммарный tx/rx контейнера раз в 15 мин в лог (охота на
  // пожирателя трафика Render — 25ГБ Pro-лимит сгорел к 10.08)
  private lastNetLogAt = 0;

  private logNetMeter(): void {
    if (Date.now() - this.lastNetLogAt < 15 * 60_000) return;
    this.lastNetLogAt = Date.now();
    const d = netMeter.tick();
    if (!d) return;
    const top = netMeter.topRoutes(3).map(r => `${r.route} ${r.mb}МБ/${r.hits}`).join(' · ') || '—';
    log.info(
      `сеть: за 15м ↑${d.txMb15}МБ ↓${d.rxMb15}МБ · с запуска (${d.sinceMin}м) ↑${d.txMbTotal}МБ ↓${d.rxMbTotal}МБ · топ HTTP: ${top}`,
      undefined, 'net',
    );
  }

  private async snapshot(): Promise<void> {
    this.logNetMeter();
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
    if (this.strategy && patch.strategyType && patch.strategyType !== settings.params.strategyType) {
      this.strategy = buildStrategy(params); // смена типа стратегии — с чистым окном
    } else {
      this.strategy?.updateParams(params);
    }
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
      : `✅ Режим: ${this.liveLabel()}`;
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
      net: { ...(readNetTotals() ?? {}), topRoutes: netMeter.topRoutes(8), topHosts: topHosts(10), tcp: tcpCensus() },
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
      crypto: this.cryptoLeg
        ? this.cryptoLeg.status()
        : { enabled: config.cryptoWeekend, running: false },
      maker: this.makerLeg
        ? this.makerLeg.status()
        : { enabled: config.makerTestnet, running: false },
      ensemble: { enabled: config.ensemble, running: this.ensembleLeg?.isRunning() ?? false },
      markets: this.marketsLeg
        ? this.marketsLeg.summary()
        : { enabled: config.ensemble && config.markets, running: false },
      moex: this.moexLeg
        ? this.moexLeg.summary()
        : { enabled: Boolean(config.tinkoffToken), running: false },
    };
  }

  /** Сводка ансамблей — FX, крипто, мультирынок и MOEX вместе (null — если выключены). */
  async ensembleStats() {
    const fx = this.ensembleLeg ? await this.ensembleLeg.stats() : null;
    const btc = this.btcEnsemble ? await this.btcEnsemble.stats() : null;
    const mkt = this.marketsLeg ? await this.marketsLeg.stats() : null;
    const moex = this.moexLeg ? await this.moexLeg.stats() : null;
    if (!fx && !btc && !mkt && !moex) return null;
    const ages = [fx?.lastQuoteAgoSec, btc?.lastQuoteAgoSec, mkt?.lastQuoteAgoSec, moex?.lastQuoteAgoSec].filter((x): x is number => typeof x === 'number');
    // groups — для Telegram (48 участников не влезают в одно сообщение 4096);
    // members плоским списком остаётся для PWA
    const groups = [
      fx ? { title: '🇪🇺 FX EUR/USD', members: fx.members } : null,
      btc ? { title: '₿ BTC (24/7)', members: btc.members } : null,
      mkt ? { title: '🌍 CFD-рынки', members: mkt.members } : null,
      moex ? { title: '🇷🇺 MOEX', members: moex.members } : null,
    ].filter((g): g is { title: string; members: NonNullable<typeof fx>['members'] } => g !== null);
    return {
      running: (fx?.running ?? false) || (btc?.running ?? false) || (mkt?.running ?? false) || (moex?.running ?? false),
      lastQuoteAgoSec: ages.length ? Math.min(...ages) : null,
      members: groups.flatMap(g => g.members),
      groups,
    };
  }
}
