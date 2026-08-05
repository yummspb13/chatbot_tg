// Мультирыночная виртуальная нога (расширение портфеля 02.08.2026).
//
// Пять победителей свипа пяти рынков (docs/PORTFOLIO-SWEEP-2026-08-01.md) торгуют
// ВИРТУАЛЬНО на живых котировках своих рынков с того же MT5-счёта, что и основной
// контур: золото (impulse), нефть (impulse), GBPJPY (meanrev + vprofile),
// S&P500 (matrend). Одно streaming-соединение MetaApi на все четыре символа
// (MultiQuoteFeed); каждая котировка масштабируется в пипс-пространство бэктеста
// и уходит в EnsembleLeg своего рынка — та же виртуальная механика, что у FX- и
// BTC-ансамблей: сделки в БД (mode=virtual, symbol=XAU_USD~gold-impulse и т.п.),
// деньги не затронуты.
//
// Эти рынки живут сессиями, а не 24/7: ночные перерывы и выходные — это молчание
// котировок, книги просто ждут. Поэтому вотчдог мягкий: аномалия — тишина ВСЕХ
// символов больше часа в будни (GBPJPY тикает 24/5, с ним такого не бывает).

import { config } from '../config';
import { errMsg, log } from '../logger';
import { MarketLegSpec, MARKET_LEGS } from './params';
import { EnsembleDeps, EnsembleLeg } from './ensemble';
import { isFxWeekend } from './risk';
import { MultiQuoteFeed } from '../broker/multiquote';
import { sleep } from '../broker/types';

export class MarketsLeg {
  private legs: Array<{ spec: MarketLegSpec; leg: EnsembleLeg }> = [];
  private feed: MultiQuoteFeed | null = null;
  private abort: AbortController | null = null;
  private loopPromise: Promise<void> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastAnyQuoteAt = 0;

  constructor(private deps: EnsembleDeps, private specs: MarketLegSpec[] = MARKET_LEGS) {}

  isRunning(): boolean {
    return this.running;
  }

  private symbols(): string[] {
    return this.specs.map(s => s.mt5Symbol);
  }

  async start(gapStart?: Date | null): Promise<void> {
    if (this.running) return;
    if (!config.metaapiToken || !config.metaapiAccountId) {
      throw new Error('мультирыночная нога требует METAAPI_TOKEN и METAAPI_ACCOUNT_ID');
    }
    this.legs = this.specs.map(spec => ({
      spec,
      leg: new EnsembleLeg(
        this.deps,
        { baseSymbol: spec.baseSymbol, crypto: false, warmup: { instrument: spec.warmupInstrument, scale: spec.priceScale } },
        spec.roster,
      ),
    }));
    // прогревы четырёх рынков параллельно: на холодном кэше Dukascopy это минуты
    await Promise.all(this.legs.map(l => l.leg.start(gapStart)));
    this.running = true;
    this.loopPromise = this.loop();
    this.watchdog = setInterval(() => this.checkWatchdog(), 60_000);
    log.success(
      `мультирыночная нога запущена: ${this.specs.map(s => `${s.key} (${s.roster.map(r => r.key).join('+')})`).join(', ')} — виртуально, один MetaApi-стрим`,
      undefined, 'markets',
    );
  }

  async stop(): Promise<void> {
    if (!this.running) return;
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
    await this.feed?.shutdown().catch(() => {});
    this.feed = null;
    for (const l of this.legs) l.leg.stop();
    log.info('мультирыночная нога остановлена', undefined, 'markets');
  }

  private async loop(): Promise<void> {
    let backoff = 1000;
    while (this.running) {
      this.abort = new AbortController();
      try {
        const token = config.metaapiToken;
        const accountId = config.metaapiAccountId;
        if (!token || !accountId) break;
        // каждый заход — свежий фид: после падения/вотчдога гарантированно чистое состояние
        this.feed = new MultiQuoteFeed({ token, accountId, symbols: this.symbols() });
        const bySymbol = new Map(this.legs.map(l => [l.spec.mt5Symbol, l]));
        for await (const q of this.feed.stream(this.abort.signal)) {
          if (!this.running) break;
          backoff = 1000;
          this.lastAnyQuoteAt = Date.now();
          const l = bySymbol.get(q.mt5Symbol);
          if (!l) continue;
          await l.leg.onQuote({
            symbol: l.spec.baseSymbol,
            bid: q.bid / l.spec.priceScale,
            ask: q.ask / l.spec.priceScale,
            time: q.time,
          });
        }
        if (this.running) log.warn('мультирыночный стрим завершился, реконнект…', undefined, 'markets');
      } catch (e) {
        if (this.running) log.warn(`мультирыночный стрим упал: ${errMsg(e)}`, undefined, 'markets');
      }
      await this.feed?.shutdown().catch(() => {});
      this.feed = null;
      if (this.running) {
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  }

  /** Тишина всех символов > 60 мин в будни — залипшее соединение, пересоздаём. */
  private checkWatchdog(): void {
    if (!this.running || !this.lastAnyQuoteAt || isFxWeekend(new Date())) return;
    if (Date.now() - this.lastAnyQuoteAt > 60 * 60_000) {
      log.warn('мультирыночный вотчдог: тишина > 60 мин в будни — пересоздаю соединение', undefined, 'markets');
      this.lastAnyQuoteAt = Date.now();
      this.abort?.abort();
    }
  }

  /** Сводка в форме EnsembleLeg.stats(): участники всех рынков одним списком. */
  async stats(): Promise<{
    running: boolean;
    lastQuoteAgoSec: number | null;
    members: Awaited<ReturnType<EnsembleLeg['stats']>>['members'];
  }> {
    const all = await Promise.all(this.legs.map(l => l.leg.stats()));
    const ages = all.map(s => s.lastQuoteAgoSec).filter((x): x is number => typeof x === 'number');
    return {
      running: this.running,
      lastQuoteAgoSec: ages.length ? Math.min(...ages) : null,
      members: all.flatMap(s => s.members),
    };
  }

  summary() {
    return {
      enabled: true,
      running: this.running,
      markets: this.specs.map(s => s.key),
      lastQuoteAgoSec: this.lastAnyQuoteAt ? Math.round((Date.now() - this.lastAnyQuoteAt) / 1000) : null,
    };
  }
}
