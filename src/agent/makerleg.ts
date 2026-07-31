// Мейкер-нога (эксперимент на Binance Futures TESTNET, MAKER_TESTNET=1).
//
// Переигрываем страддл в среде, где он имеет право жить: на бирже пассивная
// сторона не платит спред, а платит ИЗВЕСТНУЮ комиссию мейкера (~0.02%), и
// post-only (GTX) гарантирует, что тейкером мы не окажемся никогда.
// Механика цикла (one-way позиция, нетто):
//   ФЛЭТ + тихо (StraddleStrategy-гейт) → post-only buy@bid и sell@ask;
//   исполнились обе → нетто-ноль: круг закрыт, собрали спред минус 2 комиссии;
//   исполнилась одна → инвентарь: держим выходную post-only котировку на
//   пассивной стороне (переставляем за рынком), стоп-лосс и тайм-стоп — по
//   рынку (reduceOnly, платим тейкера — это цена ошибки).
// Учёт: по userTrades (realizedPnl и commission каждого филла), круг = переход
// позиции через ноль. Деньги фейковые, стакан и мэтчинг настоящие.
//
// ЧЕСТНАЯ РАМКА: CFD-версия страддла в бэктесте мертва (adverse selection);
// здесь другая структура издержек — это ТЕСТ гипотезы, не торговая система.
// Тестнет-филлы льстят (толпы HFT в стакане тестнета нет) — положительный
// результат будет поводом для следующих ворот, а не выводом.

import { config } from '../config';
import { errMsg, log } from '../logger';
import { AgentParams } from './params';
import { StraddleStrategy } from './strategy';
import { BinanceFuturesClient, FuturesFill, SymbolRules } from '../broker/binancef';
import { PIP, Quote, sleep } from '../broker/types';
import type { TradeStore } from '../store';

export interface MakerLegDeps {
  store: TradeStore;
  notify: (text: string) => Promise<void>;
}

const SCALE = 100_000; // BTC: пип 0.0001 в масштабе = $10 реальных
const MODE = 'testnet';
const DB_SYMBOL = 'BTC_USDT';

export const MAKER_PRESET: AgentParams = {
  strategyType: 'straddle',
  windowSec: 600,
  thresholdPips: 12,   // тихий рынок: диапазон 10 мин ≤ 12 пипсов ($120)
  tpPips: 0,           // выход не по TP, а пассивной котировкой за рынком
  slPips: 40,          // стоп инвентаря: $400 хода × 0.001 BTC = $0.40
  cooldownSec: 30,
  units: 100,          // 100/100000 = 0.001 BTC — минимальный лот
  maxConcurrent: 2,
  maxTradesPerDay: 300, // кругов в день
  maxDailyLossUsd: 5,
  spreadGuardPips: 5,
  newsBufferMin: 0,
  entryMode: 'limit',
  entryTtlSec: 60,
  entryOffsetPips: 0,
  tradeHoursUtc: [],
  autoBlackoutHours: [],
};

const TIME_STOP_SEC = 900; // инвентарь старше 15 мин закрываем по рынку

interface Cycle {
  openedAt: Date;
  side: 'BUY' | 'SELL';
  fills: FuturesFill[];
}

export class MakerLeg {
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private client: BinanceFuturesClient;
  private strategy = new StraddleStrategy(MAKER_PRESET);
  private rules: SymbolRules = { tickSize: 0.1, stepSize: 0.001, minQty: 0.001 };
  private qtyBtc = MAKER_PRESET.units / SCALE;

  private fillCursor: number | undefined;
  private cycle: Cycle | null = null;
  private inventorySince = 0;
  private lastRepriceAt = 0;
  private lastStateSyncAt = 0;
  private posAmt = 0;
  private posEntry = 0;
  private posUnrealized = 0;
  private openOrderCount = 0;
  private oldestOrderAt = 0;
  private quotedAt = 0;

  private dayKey = '';
  private haltDay = '';
  private tradesToday = 0;
  private realizedToday = 0;
  private lastQuote: Quote | null = null;
  private lastQuoteAt = 0;
  private lastSnapshotAt = 0;
  private lastError: string | null = null;

  constructor(private deps: MakerLegDeps) {
    if (!config.binanceTestnetKey || !config.binanceTestnetSecret) {
      throw new Error('мейкер-нога требует BINANCE_TESTNET_KEY и BINANCE_TESTNET_SECRET');
    }
    this.client = new BinanceFuturesClient(config.binanceTestnetKey, config.binanceTestnetSecret);
  }

  isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.rules = await this.client.symbolRules(config.binanceSymbol);
    this.qtyBtc = Math.max(this.rules.minQty, MAKER_PRESET.units / SCALE);
    // курсор филлов: всё, что было до старта, не наше
    const prev = await this.client.userTrades(config.binanceSymbol).catch(() => [] as FuturesFill[]);
    this.fillCursor = prev.length ? Math.max(...prev.map(f => f.id)) + 1 : 0;
    this.dayKey = new Date().toISOString().slice(0, 10);
    this.tradesToday = await this.deps.store.countTradesToday(MODE, DB_SYMBOL);
    this.realizedToday = await this.deps.store.realizedPnlToday(MODE, DB_SYMBOL);
    // инвентарь, переживший рестарт — усыновляем
    const pos = await this.client.position(config.binanceSymbol);
    this.posAmt = pos.amt;
    if (pos.amt !== 0) {
      this.cycle = { openedAt: new Date(), side: pos.amt > 0 ? 'BUY' : 'SELL', fills: [] };
      this.inventorySince = Date.now();
      log.warn(`мейкер: найден инвентарь с прошлого запуска (${pos.amt} BTC) — управляю им`, undefined, 'maker');
    }
    this.running = true;
    this.loopPromise = this.loop();
    log.success(
      `мейкер-нога запущена: Binance Futures TESTNET, ${config.binanceSymbol}, qty ${this.qtyBtc} BTC, `
      + `тихий гейт ≤${MAKER_PRESET.thresholdPips}p/${MAKER_PRESET.windowSec / 60}м, дневной лимит ${MAKER_PRESET.maxDailyLossUsd}$ (фейковые деньги)`,
      undefined, 'maker',
    );
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.abort?.abort();
    if (this.loopPromise) {
      await this.loopPromise.catch(() => {});
      this.loopPromise = null;
    }
    // чистый выход: снять котировки, закрыть инвентарь (деньги фейковые,
    // а вот брошенный без стопов инвентарь испортил бы статистику)
    try {
      await this.client.cancelAll(config.binanceSymbol);
      const pos = await this.client.position(config.binanceSymbol);
      if (pos.amt !== 0) {
        await this.client.marketClose(config.binanceSymbol, pos.amt);
        await this.collectFills();
      }
    } catch (e) {
      log.warn(`мейкер: остановка не дочистила: ${errMsg(e)}`, undefined, 'maker');
    }
    log.info('мейкер-нога остановлена', undefined, 'maker');
  }

  private roundPrice(scaled: number): number {
    const real = scaled * SCALE;
    return Math.round(real / this.rules.tickSize) * this.rules.tickSize;
  }

  private priceStr(real: number): number {
    const dec = Math.max(0, -Math.floor(Math.log10(this.rules.tickSize)));
    return Number(real.toFixed(dec));
  }

  private slUsd(): number {
    return MAKER_PRESET.slPips * PIP * SCALE * this.qtyBtc;
  }

  private halted(): boolean {
    return this.haltDay === this.dayKey;
  }

  private async loop(): Promise<void> {
    let backoff = 1000;
    while (this.running) {
      this.abort = new AbortController();
      try {
        await this.tick();
        backoff = 1000;
      } catch (e) {
        this.lastError = errMsg(e);
        log.warn(`мейкер tick: ${this.lastError}`, undefined, 'maker');
        await sleep(backoff, this.abort.signal);
        backoff = Math.min(backoff * 2, 60_000);
      }
      await sleep(700, this.abort.signal);
    }
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    const day = new Date().toISOString().slice(0, 10);
    if (day !== this.dayKey) {
      this.dayKey = day;
      this.tradesToday = await this.deps.store.countTradesToday(MODE, DB_SYMBOL);
      this.realizedToday = await this.deps.store.realizedPnlToday(MODE, DB_SYMBOL);
    }

    const top = await this.client.bookTicker(config.binanceSymbol);
    const q: Quote = {
      symbol: DB_SYMBOL,
      bid: top.bid / SCALE,
      ask: top.ask / SCALE,
      time: new Date(top.ts),
    };
    this.lastQuote = q;
    this.lastQuoteAt = now;
    const sig = this.strategy.onQuote(q); // гейт «тихо ли» + собственный кулдаун

    // состояние позиции/ордеров и филлы — не чаще раза в 3 секунды
    if (now - this.lastStateSyncAt > 3000) {
      this.lastStateSyncAt = now;
      const [pos, orders] = await Promise.all([
        this.client.position(config.binanceSymbol),
        this.client.openOrders(config.binanceSymbol),
      ]);
      const wasAmt = this.posAmt;
      this.posAmt = pos.amt;
      this.posEntry = pos.entryPrice;
      this.posUnrealized = pos.unrealized;
      this.openOrderCount = orders.length;
      if (wasAmt === 0 && pos.amt !== 0) {
        this.cycle = this.cycle ?? { openedAt: new Date(), side: pos.amt > 0 ? 'BUY' : 'SELL', fills: [] };
        this.inventorySince = now;
      }
      await this.collectFills();
      if (wasAmt !== 0 && pos.amt === 0) await this.finalizeCycle();
    }

    if (now - this.lastSnapshotAt > 60_000) {
      this.lastSnapshotAt = now;
      const b = await this.client.balanceUsdt().catch(() => null);
      if (b) await this.deps.store.saveSnapshot(MODE, b.balance, b.balance + this.posUnrealized, this.posAmt ? 1 : 0);
    }

    if (!this.running) return;

    if (this.posAmt !== 0) {
      await this.manageInventory(top.bid, top.ask, now);
      return;
    }

    // ФЛЭТ
    if (this.openOrderCount > 0 && this.oldestOrderAt && now - this.oldestOrderAt > MAKER_PRESET.entryTtlSec * 1000) {
      await this.client.cancelAll(config.binanceSymbol);
      this.openOrderCount = 0;
      return;
    }
    if (this.halted() || !sig || this.openOrderCount > 0) return;
    if (this.tradesToday >= MAKER_PRESET.maxTradesPerDay) return;
    if (now - this.quotedAt < MAKER_PRESET.cooldownSec * 1000) return;

    this.quotedAt = now;
    this.oldestOrderAt = now;
    const id = `mk${now % 1_000_000_000}`;
    const [buy, sell] = await Promise.all([
      this.client.placePostOnly(config.binanceSymbol, 'BUY', this.qtyBtc, this.priceStr(top.bid), `${id}b`),
      this.client.placePostOnly(config.binanceSymbol, 'SELL', this.qtyBtc, this.priceStr(top.ask), `${id}s`),
    ]);
    this.openOrderCount = (buy ? 1 : 0) + (sell ? 1 : 0);
    if (this.openOrderCount) {
      log.info(`⚗️ котировки выставлены: ${buy ? `buy@${top.bid}` : '—'} / ${sell ? `sell@${top.ask}` : '—'}`, undefined, 'maker');
    }
  }

  /** Инвентарь: держать выходную post-only котировку, стоп и тайм-стоп по рынку. */
  private async manageInventory(bid: number, ask: number, now: number): Promise<void> {
    const stopHit = this.posUnrealized <= -this.slUsd();
    const timeHit = this.inventorySince && now - this.inventorySince > TIME_STOP_SEC * 1000;
    if (stopHit || timeHit || this.halted()) {
      await this.client.cancelAll(config.binanceSymbol);
      await this.client.marketClose(config.binanceSymbol, this.posAmt);
      log.warn(`мейкер: инвентарь закрыт по рынку (${stopHit ? 'стоп' : timeHit ? 'тайм-стоп' : 'пауза дня'})`, undefined, 'maker');
      this.lastStateSyncAt = 0; // форсируем пересинк на следующем тике
      return;
    }
    // переставляем выходную котировку не чаще раза в 3 секунды
    if (now - this.lastRepriceAt < 3000) return;
    this.lastRepriceAt = now;
    const exitSide: 'BUY' | 'SELL' = this.posAmt > 0 ? 'SELL' : 'BUY';
    const exitPrice = this.priceStr(exitSide === 'SELL' ? ask : bid);
    await this.client.cancelAll(config.binanceSymbol);
    await this.client.placePostOnly(config.binanceSymbol, exitSide, Math.abs(this.posAmt), exitPrice, `mx${now % 1_000_000_000}`);
  }

  private async collectFills(): Promise<void> {
    const fills = await this.client.userTrades(config.binanceSymbol, this.fillCursor);
    if (!fills.length) return;
    this.fillCursor = Math.max(...fills.map(f => f.id)) + 1;
    if (!this.cycle) this.cycle = { openedAt: new Date(fills[0].time), side: fills[0].side, fills: [] };
    this.cycle.fills.push(...fills);
  }

  /** Позиция вернулась в ноль — круг закрыт: одна запись в БД, счётчики, уведомления. */
  private async finalizeCycle(): Promise<void> {
    const c = this.cycle;
    this.cycle = null;
    this.inventorySince = 0;
    if (!c || !c.fills.length) return;
    const opens = c.fills.filter(f => f.side === c.side);
    const closes = c.fills.filter(f => f.side !== c.side);
    const wavg = (fs: FuturesFill[]) => {
      const qty = fs.reduce((s, f) => s + f.qty, 0);
      return qty ? fs.reduce((s, f) => s + f.price * f.qty, 0) / qty : 0;
    };
    const commission = c.fills.reduce((s, f) => s + f.commission, 0);
    const pnl = c.fills.reduce((s, f) => s + f.realizedPnl, 0) - commission;
    const makerFills = c.fills.filter(f => f.maker).length;

    this.tradesToday += 1;
    this.realizedToday += pnl;
    const row = await this.deps.store.openTrade({
      mode: MODE,
      symbol: DB_SYMBOL,
      side: c.side,
      units: MAKER_PRESET.units,
      entryPrice: wavg(opens) / SCALE,
      slPrice: null,
      tpPrice: null,
      openedAt: c.openedAt,
      costSpread: 0,
      costCommission: commission,
      brokerTradeId: `cycle-${c.fills[0].id}`,
      spreadAtEntry: this.lastQuote ? (this.lastQuote.ask - this.lastQuote.bid) / PIP : 0,
      volAtEntry: this.strategy.windowRangePips(),
      hourUtc: c.openedAt.getUTCHours(),
      newsDistMin: null,
      paramsSnapshot: MAKER_PRESET,
    });
    await this.deps.store.closeTradeById(row.id, {
      exitPrice: wavg(closes) / SCALE,
      closedAt: new Date(),
      pnl,
      closeReason: makerFills === c.fills.length ? 'TP' : 'SL', // все филлы мейкерские = чистый круг
    });

    log.info(`⚗️ круг закрыт: ${c.side} ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)}$ (комиссии ${commission.toFixed(4)}$, филлов ${c.fills.length}, мейкерских ${makerFills}) · день ${this.realizedToday >= 0 ? '+' : ''}${this.realizedToday.toFixed(3)}$/${this.tradesToday} кругов`, undefined, 'maker');
    if (this.tradesToday === 1 || Math.abs(pnl) >= 0.05) {
      await this.deps.notify(
        `⚗️ Мейкер-тестнет: круг №${this.tradesToday} за день, ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)}$ `
        + `(комиссии ${commission.toFixed(4)}$)\nЗа день: ${this.realizedToday >= 0 ? '+' : ''}${this.realizedToday.toFixed(3)}$`,
      );
    }

    if (this.realizedToday <= -MAKER_PRESET.maxDailyLossUsd && !this.halted()) {
      this.haltDay = this.dayKey;
      await this.client.cancelAll(config.binanceSymbol).catch(() => {});
      await this.deps.notify(
        `⚗️🟠 Мейкер-тестнет: дневной лимит −${MAKER_PRESET.maxDailyLossUsd}$ достигнут (${this.realizedToday.toFixed(2)}$) — пауза до следующего дня UTC.`,
      );
    }
  }

  status() {
    return {
      enabled: true,
      running: this.running,
      venue: 'binance-futures-testnet',
      symbol: config.binanceSymbol,
      qtyBtc: this.qtyBtc,
      quiet: this.lastQuote !== null && this.strategy.windowRangePips() <= MAKER_PRESET.thresholdPips,
      inventoryBtc: this.posAmt,
      unrealized: this.posUnrealized,
      haltedToday: this.halted(),
      tradesToday: this.tradesToday,
      realizedToday: this.realizedToday,
      lastQuoteAgoSec: this.lastQuoteAt ? Math.round((Date.now() - this.lastQuoteAt) / 1000) : null,
      lastError: this.lastError,
      maxDailyLossUsd: MAKER_PRESET.maxDailyLossUsd,
    };
  }
}
