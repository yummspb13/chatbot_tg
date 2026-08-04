// Ансамбль виртуальных стратегий (ENSEMBLE, включён по умолчанию в live).
//
// Все стратегии из ростера крутятся ПАРАЛЛЕЛЬНО на живом котировочном потоке
// EUR/USD (движок передаёт сюда каждый тик), но торгуют ВИРТУАЛЬНО: та же
// пессимистичная модель лимитных филлов, что в бэктесте (касание bid/ask),
// TP/SL по котировкам, сделки в БД под mode=virtual, symbol=EUR_USD~<key>.
// Деньги не затрагиваются вообще.
//
// Зачем:
// - spreadweather впервые видит НАСТОЯЩИЙ живой спред (её главный вход);
// - участник meanrev = копия живого контура: разница его виртуальных и
//   реальных результатов — чистый замер качества исполнения;
// - «лицензии» пока справочные (14 дней, ≥10 сделок, net>0): смотрим, кому
//   ансамбль ДАЛ БЫ объём, прежде чем доверять такое решение коду.
//
// Прогрев: echo (20-дневное расписание) и spreadweather (базовая линия спреда)
// при старте кормятся историей Dukascopy с реальным спредом — участвуют сразу.

import { errMsg, log } from '../logger';
import { AgentParams, EnsembleMember, ENSEMBLE_MEMBERS } from './params';
import { buildStrategy, TradingStrategy } from './strategy';
import { RiskManager } from './risk';
import { PIP, Quote, round5 } from '../broker/types';
import type { TradeStore } from '../store';

export interface EnsembleDeps {
  store: TradeStore;
  isNewsBlackout: (ts: Date, bufferMin: number) => boolean;
}

export interface EnsembleConfig {
  baseSymbol: string; // EUR_USD | BTC_USD — префикс виртуальных символов в БД
  crypto: boolean;    // true → риск-модуль не применяет блок FX-выходных (24/7)
  warmup: { instrument: string; scale: number } | null; // история для прогрева
  commissionFrac?: number; // доля нотионала за круг (MOEX 0.001) — вычитается из pnl при закрытии
}

const MODE = 'virtual';

interface VPending {
  side: 'BUY' | 'SELL';
  price: number;
  tp: number;
  sl: number;
  placedAt: number;
}

interface VOpen {
  rowId: number;
  side: 'BUY' | 'SELL';
  entry: number;
  tp: number;
  sl: number;
  openedAt: number;   // для тайм-выхода (maxHoldSec)
  beLocked?: boolean; // BE-лок: SL уже перенесён на вход
}

class MemberState {
  strategy: TradingStrategy;
  risk: RiskManager;
  pending: VPending[] = [];
  open: VOpen[] = [];
  dayKey = '';
  tradesToday = 0;
  realizedToday = 0;

  constructor(public member: EnsembleMember, private baseSymbol: string) {
    this.strategy = buildStrategy(member.params);
    this.risk = new RiskManager(member.params);
  }

  symbol(): string {
    return `${this.baseSymbol}~${this.member.key}`;
  }
}

export class EnsembleLeg {
  private members: MemberState[];
  private running = false;
  private lastQuoteAt = 0;

  constructor(
    private deps: EnsembleDeps,
    private cfg: EnsembleConfig = { baseSymbol: 'EUR_USD', crypto: false, warmup: { instrument: 'eurusd', scale: 1 } },
    roster: EnsembleMember[] = ENSEMBLE_MEMBERS,
  ) {
    this.members = roster.map(m => new MemberState(m, cfg.baseSymbol));
  }

  isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    if (this.running) return;
    for (const m of this.members) {
      m.dayKey = new Date().toISOString().slice(0, 10);
      m.tradesToday = await this.deps.store.countTradesToday(MODE, m.symbol());
      m.realizedToday = await this.deps.store.realizedPnlToday(MODE, m.symbol());
      // открытые виртуальные позиции переживают рестарт — усыновляем из БД
      const rows = await this.deps.store.listOpenTrades(MODE, m.symbol());
      m.open = rows
        .filter(r => r.tpPrice !== null && r.slPrice !== null)
        .map(r => ({ rowId: r.id, side: r.side, entry: r.entryPrice, tp: r.tpPrice!, sl: r.slPrice!, openedAt: r.openedAt.getTime() }));
    }
    await this.warmupFromHistory();
    this.running = true;
    log.success(
      `ансамбль ${this.cfg.baseSymbol} запущен: ${this.members.map(m => m.member.key).join(', ')} — виртуально, на живых котировках`,
      undefined, 'ensemble',
    );
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    for (const m of this.members) m.pending = []; // лимитки в памяти; открытые позиции ждут в БД
    log.info('ансамбль остановлен', undefined, 'ensemble');
  }

  /** Прогрев стратегий историей с реальным спредом (echo — 20-дневное расписание,
   *  spreadweather — базовая линия). Сигналы прогрева отбрасываются. */
  private async warmupFromHistory(): Promise<void> {
    const w = this.cfg.warmup;
    if (!w) return;
    try {
      const { loadM1WithSpread } = await import('../backtest/data');
      const to = new Date();
      const from = new Date(Date.now() - 26 * 86400_000);
      const candles = await loadM1WithSpread(w.instrument, from, to);
      if (candles.length < 1440) {
        log.warn(`ансамбль ${this.cfg.baseSymbol}: мало истории для прогрева (${candles.length}) — холодный старт`, undefined, 'ensemble');
        return;
      }
      for (const c of candles) {
        const mid = c.c / w.scale;
        const half = ((c.sp ?? PIP) / w.scale) / 2;
        const q: Quote = { symbol: this.cfg.baseSymbol, bid: mid - half, ask: mid + half, time: new Date(c.t) };
        for (const m of this.members) m.strategy.onQuote(q);
      }
      log.success(`ансамбль ${this.cfg.baseSymbol}: прогрев ${candles.length} минуток (echo и spreadweather готовы сразу)`, undefined, 'ensemble');
    } catch (e) {
      log.warn(`ансамбль ${this.cfg.baseSymbol}: прогрев не удался (${errMsg(e)}) — echo даст сигналы через ~5 дней`, undefined, 'ensemble');
    }
  }

  /** Вызывается движком на каждом живом тике. Всё в памяти, БД — только на филлах/закрытиях. */
  async onQuote(q: Quote): Promise<void> {
    if (!this.running) return;
    this.lastQuoteAt = Date.now();
    const spreadPips = (q.ask - q.bid) / PIP;
    const dayKey = q.time.toISOString().slice(0, 10);

    for (const m of this.members) {
      try {
        await this.step(m, q, spreadPips, dayKey);
      } catch (e) {
        log.warn(`ансамбль ${m.member.key}: ${errMsg(e)}`, undefined, 'ensemble');
      }
    }
  }

  private async step(m: MemberState, q: Quote, spreadPips: number, dayKey: string): Promise<void> {
    if (dayKey !== m.dayKey) {
      m.dayKey = dayKey;
      m.tradesToday = 0;
      m.realizedToday = 0;
    }
    const p = m.member.params;
    const now = q.time.getTime();

    // 1) исполнение отложенных лимиток (модель бэктеста: касание пассивной стороны)
    if (m.pending.length) {
      const keep: VPending[] = [];
      for (const pe of m.pending) {
        if (now - pe.placedAt > p.entryTtlSec * 1000) continue; // истёк
        const fills = pe.side === 'BUY' ? q.bid <= pe.price : q.ask >= pe.price;
        if (!fills) {
          keep.push(pe);
          continue;
        }
        const row = await this.deps.store.openTrade({
          mode: MODE,
          symbol: m.symbol(),
          side: pe.side,
          units: p.units,
          entryPrice: pe.price,
          slPrice: pe.sl,
          tpPrice: pe.tp,
          openedAt: q.time,
          costSpread: 0,
          costCommission: 0,
          brokerTradeId: null,
          spreadAtEntry: spreadPips,
          volAtEntry: m.strategy.windowRangePips(),
          hourUtc: q.time.getUTCHours(),
          newsDistMin: null,
          paramsSnapshot: p,
        });
        m.open.push({ rowId: row.id, side: pe.side, entry: pe.price, tp: pe.tp, sl: pe.sl, openedAt: q.time.getTime() });
        m.tradesToday += 1;
      }
      m.pending = keep;
    }

    // 2) TP/SL открытых (оба задеты в одном тике — невозможно: тик один)
    if (m.open.length) {
      const keep: VOpen[] = [];
      for (const o of m.open) {
        let exit: number | null = null;
        let reason = '';
        if (o.side === 'BUY') {
          if (q.bid <= o.sl) { exit = o.sl; reason = 'SL'; }
          else if (q.bid >= o.tp) { exit = o.tp; reason = 'TP'; }
        } else {
          if (q.ask >= o.sl) { exit = o.sl; reason = 'SL'; }
          else if (q.ask <= o.tp) { exit = o.tp; reason = 'TP'; }
        }
        // тайм-выход по рынку (пассивная сторона) — механика намайненных правил
        if (exit === null && p.maxHoldSec > 0 && now - o.openedAt >= p.maxHoldSec * 1000) {
          exit = o.side === 'BUY' ? q.bid : q.ask;
          reason = 'TIME';
        }
        if (exit === null) {
          // BE-лок: пройдена доля пути к TP → SL переносится на вход
          if (p.beLockFrac > 0 && !o.beLocked) {
            const trigger = o.entry + (o.tp - o.entry) * p.beLockFrac;
            const reached = o.side === 'BUY' ? q.bid >= trigger : q.ask <= trigger;
            if (reached) {
              o.sl = o.entry;
              o.beLocked = true;
            }
          }
          keep.push(o);
          continue;
        }
        const commission = (this.cfg.commissionFrac ?? 0) * o.entry * m.member.params.units;
        const pnl = (o.side === 'BUY' ? exit - o.entry : o.entry - exit) * m.member.params.units - commission;
        await this.deps.store.closeTradeById(o.rowId, {
          exitPrice: exit,
          closedAt: q.time,
          pnl,
          closeReason: o.beLocked && exit === o.entry ? 'BE' : reason,
        });
        m.realizedToday += pnl;
      }
      m.open = keep;
    }

    // 3) новый сигнал → виртуальная лимитка (страддлов в ростере нет)
    const sig = m.strategy.onQuote(q);
    if (!sig || sig.both) return;
    const verdict = m.risk.check({
      now: q.time,
      openCount: m.open.length + m.pending.length,
      tradesToday: m.tradesToday,
      plToday: m.realizedToday,
      spreadPips,
      newsBlackout: this.deps.isNewsBlackout(q.time, p.newsBufferMin),
      crypto: this.cfg.crypto,
    });
    if (!verdict.ok) return;
    if (p.entryMode === 'market') {
      // рыночный вход: платим спред сразу (механика намайненных правил)
      const entry = sig.side === 'BUY' ? q.ask : q.bid;
      const tp = round5(sig.side === 'BUY' ? entry + sig.tpPips * PIP : entry - sig.tpPips * PIP);
      const sl = round5(sig.side === 'BUY' ? entry - sig.slPips * PIP : entry + sig.slPips * PIP);
      const row = await this.deps.store.openTrade({
        mode: MODE,
        symbol: m.symbol(),
        side: sig.side,
        units: p.units,
        entryPrice: entry,
        slPrice: sl,
        tpPrice: tp,
        openedAt: q.time,
        costSpread: (q.ask - q.bid) * p.units,
        costCommission: 0,
        brokerTradeId: null,
        spreadAtEntry: spreadPips,
        volAtEntry: m.strategy.windowRangePips(),
        hourUtc: q.time.getUTCHours(),
        newsDistMin: null,
        paramsSnapshot: p,
      });
      m.open.push({ rowId: row.id, side: sig.side, entry, tp, sl, openedAt: q.time.getTime() });
      m.tradesToday += 1;
      return;
    }
    const price = round5(sig.side === 'BUY' ? q.bid - p.entryOffsetPips * PIP : q.ask + p.entryOffsetPips * PIP);
    m.pending.push({
      side: sig.side,
      price,
      tp: round5(sig.side === 'BUY' ? price + sig.tpPips * PIP : price - sig.tpPips * PIP),
      sl: round5(sig.side === 'BUY' ? price - sig.slPips * PIP : price + sig.slPips * PIP),
      placedAt: now,
    });
  }

  /** Сводка для панели/TG: 14-дневная статистика из БД + живое состояние. */
  async stats(): Promise<{
    running: boolean;
    lastQuoteAgoSec: number | null;
    members: Array<{
      key: string;
      strategy: string;
      trades14: number;
      net14: number;
      expectancy14: number;
      winRate14: number;
      openNow: number;
      pendingNow: number;
      tradesToday: number;
      realizedToday: number;
      license: 'granted' | 'denied' | 'collecting';
    }>;
  }> {
    const since = new Date(Date.now() - 14 * 86400_000);
    const all = await this.deps.store.closedTradesSince(MODE, since);
    return {
      running: this.running,
      lastQuoteAgoSec: this.lastQuoteAt ? Math.round((Date.now() - this.lastQuoteAt) / 1000) : null,
      members: this.members.map(m => {
        const mine = all.filter(t => t.symbol === m.symbol());
        const net = mine.reduce((s, t) => s + (t.pnl ?? 0), 0);
        const wins = mine.filter(t => (t.pnl ?? 0) > 0).length;
        const license = mine.length >= 10 ? (net > 0 ? 'granted' as const : 'denied' as const) : 'collecting' as const;
        return {
          key: m.member.key,
          strategy: `${m.member.params.strategyType}/${m.member.params.entryMode}`,
          trades14: mine.length,
          net14: +net.toFixed(2),
          expectancy14: mine.length ? +(net / mine.length).toFixed(3) : 0,
          winRate14: mine.length ? +(wins / mine.length * 100).toFixed(1) : 0,
          openNow: m.open.length,
          pendingNow: m.pending.length,
          tradesToday: m.tradesToday,
          realizedToday: +m.realizedToday.toFixed(2),
          license,
        };
      }),
    };
  }
}
