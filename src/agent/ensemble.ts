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
  // внешний гейт входа (oilguard и т.п.): false → сигнал участника молча
  // пропускается; уже открытые позиции не трогает. Fail-open по построению
  entryGuard?: (memberKey: string, side: 'BUY' | 'SELL', time: Date) => boolean;
  // форс-выход на разрыве котировок > N минут (модель moex-sweep: овернайт-гэпы
  // через стопы не прыгают). Первая котировка после разрыва закрывает открытые
  // по пассивной стороне (reason GAP) и сносит отложки. 0/выкл — держим через ночь
  gapCloseMin?: number;
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
  mult?: number;      // hot-hand множитель размера, зафиксирован при открытии
  trailing?: boolean; // трейл-выход взведён: TP тронут при trailAfterTpFrac>0
  peak?: number;      // лучшая цена после взвода (BUY: max bid, SELL: min ask);
                      // рестарт это поле теряет — трейл взводится заново первым
                      // тиком за TP, пик консервативно стартует с текущей цены
}

class MemberState {
  strategy: TradingStrategy;
  risk: RiskManager;
  pending: VPending[] = [];
  open: VOpen[] = [];
  dayKey = '';
  tradesToday = 0;
  realizedToday = 0;
  winStreakToday = 0; // подряд плюсовых закрытий сегодня (hot-hand-лесенка)

  constructor(public member: EnsembleMember, private baseSymbol: string) {
    this.strategy = buildStrategy(member.params);
    this.risk = new RiskManager(member.params);
  }

  symbol(): string {
    return `${this.baseSymbol}~${this.member.key}`;
  }

  /** Множитель размера следующей сделки: как в оверлее бэктеста — по уже
   *  ЗАКРЫТЫМ сделкам текущего дня, без подглядывания в будущее. */
  hhMult(): number {
    if (!this.member.params.hotHandLadder) return 1;
    return this.winStreakToday >= 5 ? 5 : this.winStreakToday >= 3 ? 3 : 1;
  }
}

/** Событие живой виртуальной сделки — для зеркал (micro-этап AFKS). Цены в
 *  ВИРТУАЛЬНОЙ шкале (нога знает свой priceScale и конвертирует сама).
 *  Во время BF-догонки/повтора истории события НЕ эмитятся. */
export interface VirtualTradeEvent {
  kind: 'open' | 'close';
  memberKey: string;
  baseSymbol: string;
  rowId: number;
  side: 'BUY' | 'SELL';
  price: number;      // entry (open) или exit (close)
  tp?: number;
  sl?: number;
  pnl?: number;       // close: виртуальные $ (с виртуальной комиссией)
  reason?: string;    // close: TP|SL|TIME|BE
  time: Date;
}

export class EnsembleLeg {
  private members: MemberState[];
  private running = false;
  private lastQuoteAt = 0;
  private tradeListeners: Array<(e: VirtualTradeEvent) => void> = [];
  // 'BF' во время догонки простоя: сделки из проигранной истории помечаются в
  // brokerTradeId (у виртуальных он всё равно пуст) — лицензии их не считают
  private backfillTag: string | null = null;
  // пока идёт проигрыш истории, живые тики дропаются: смешение исторического и
  // текущего времени в одном потоке ломало бы TP/SL и дневные счётчики
  private replaying = false;

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

  /** Подписка зеркала на живые виртуальные сделки (BF-догонка не эмитится). */
  onVirtualTrade(cb: (e: VirtualTradeEvent) => void): void {
    this.tradeListeners.push(cb);
  }

  /** Открытые позиции участника (для усыновления сирот зеркалом после рестарта). */
  openFor(memberKey: string): Array<{ rowId: number; side: 'BUY' | 'SELL'; entry: number; tp: number; sl: number }> {
    const m = this.members.find(x => x.member.key === memberKey);
    return m ? m.open.map(o => ({ rowId: o.rowId, side: o.side, entry: o.entry, tp: o.tp, sl: o.sl })) : [];
  }

  private emitTrade(e: VirtualTradeEvent): void {
    if (this.replaying || this.backfillTag) return; // история — не сигнал зеркалу
    for (const cb of this.tradeListeners) {
      try {
        cb(e);
      } catch (err) {
        log.warn(`слушатель виртуальных сделок: ${errMsg(err)}`, undefined, 'ensemble');
      }
    }
  }

  /** gapStart — вотермарк простоя: прогрев истории обрезается на нём, а
   *  [gapStart, сейчас] проигрывается ЧЕРЕЗ ПОЛНЫЙ торговый путь (филлы,
   *  TP/SL, счётчики) со сделками-BF — понимание срабатываний без дыры. */
  async start(gapStart?: Date | null): Promise<void> {
    if (this.running) return;
    const todayStart = new Date(new Date().toISOString().slice(0, 10));
    const closedToday = await this.deps.store.closedTradesSince(MODE, todayStart);
    for (const m of this.members) {
      m.dayKey = new Date().toISOString().slice(0, 10);
      m.tradesToday = await this.deps.store.countTradesToday(MODE, m.symbol());
      m.realizedToday = await this.deps.store.realizedPnlToday(MODE, m.symbol());
      // hot-hand: стрик восстанавливается из сегодняшних закрытий, чтобы рестарт
      // посреди дня не сбрасывал лесенку
      const mine = closedToday
        .filter(t => t.symbol === m.symbol())
        .sort((a, b) => (a.closedAt?.getTime() ?? 0) - (b.closedAt?.getTime() ?? 0));
      m.winStreakToday = 0;
      for (const t of mine) m.winStreakToday = (t.pnl ?? 0) > 0 ? m.winStreakToday + 1 : 0;
      // открытые виртуальные позиции переживают рестарт — усыновляем из БД
      // (множитель hot-hand восстанавливаем из записанного размера)
      const rows = await this.deps.store.listOpenTrades(MODE, m.symbol());
      m.open = rows
        .filter(r => r.tpPrice !== null && r.slPrice !== null)
        .map(r => ({
          rowId: r.id, side: r.side, entry: r.entryPrice, tp: r.tpPrice!, sl: r.slPrice!,
          openedAt: r.openedAt.getTime(),
          mult: Math.max(1, Math.round(r.units / m.member.params.units)),
        }));
    }
    await this.warmupFromHistory(gapStart ?? undefined);
    this.running = true;
    if (gapStart) await this.replayGap(gapStart);
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
   *  spreadweather — базовая линия). Сигналы прогрева отбрасываются.
   *  cutoff задан → история обрезается на нём (дальше её проиграет replayGap,
   *  чтобы стратегии не увидели один и тот же кусок дважды). */
  private async warmupFromHistory(cutoff?: Date): Promise<void> {
    const w = this.cfg.warmup;
    if (!w) return;
    try {
      const { loadM1WithSpread } = await import('../backtest/data');
      const to = cutoff ?? new Date();
      const from = new Date(to.getTime() - 26 * 86400_000);
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

  /** Догонка простоя по истории своего прогрев-инструмента (у ног без warmup —
   *  MOEX — историю подаёт нога через replayCandles). Максимум 72 часа. */
  private async replayGap(gapStart: Date): Promise<void> {
    const w = this.cfg.warmup;
    if (!w) return;
    try {
      const { loadM1WithSpread } = await import('../backtest/data');
      const from = new Date(Math.max(gapStart.getTime(), Date.now() - 72 * 3600_000));
      const candles = await loadM1WithSpread(w.instrument, from, new Date());
      await this.replayCandles(candles.filter(c => c.t >= from.getTime()), w.scale, from);
    } catch (e) {
      log.warn(`догонка ${this.cfg.baseSymbol} не удалась (${errMsg(e)}) — пропуск останется дырой`, undefined, 'ensemble');
    }
  }

  /** Проигрывает свечи через ПОЛНЫЙ торговый путь (o→h→l→c как 4 котировки);
   *  открытые в проигрыше сделки помечаются brokerTradeId='BF'. Порядок h/l
   *  внутри минуты неизвестен — модельная условность, потому и пометка:
   *  лицензии считаются только по живым тикам, BF — картина срабатываний. */
  async replayCandles(candles: Array<{ t: number; o: number; h: number; l: number; c: number; sp?: number }>, scale: number, from: Date): Promise<void> {
    if (!candles.length) {
      log.info(`догонка ${this.cfg.baseSymbol}: истории за простой нет (рынок закрыт или данные ещё не выложены)`, undefined, 'ensemble');
      return;
    }
    // идемпотентность: рестарт-петля после уже выполненной догонки этого окна
    // не должна проиграть его второй раз (задвоила бы сделки-BF)
    const prior = await this.deps.store.closedTradesSince(MODE, from);
    if (prior.some(t => t.brokerTradeId === 'BF' && t.symbol.startsWith(`${this.cfg.baseSymbol}~`))) {
      log.info(`догонка ${this.cfg.baseSymbol}: окно уже проиграно ранее — пропускаю`, undefined, 'ensemble');
      return;
    }
    this.backfillTag = 'BF';
    this.replaying = true;
    try {
      for (const c of candles) {
        const half = ((c.sp ?? PIP) / scale) / 2;
        const legPrices: Array<[number, number]> = [[c.o, 0], [c.h, 15_000], [c.l, 30_000], [c.c, 45_000]];
        for (const [price, dt] of legPrices) {
          const mid = price / scale;
          await this.processQuote({ symbol: this.cfg.baseSymbol, bid: mid - half, ask: mid + half, time: new Date(c.t + dt) });
        }
      }
    } finally {
      this.backfillTag = null;
      this.replaying = false;
    }
    const closed = await this.deps.store.closedTradesSince(MODE, from);
    const bf = closed.filter(t => t.brokerTradeId === 'BF' && t.symbol.startsWith(`${this.cfg.baseSymbol}~`));
    const bfNet = bf.reduce((s, t) => s + (t.pnl ?? 0), 0);
    log.success(
      `догонка ${this.cfg.baseSymbol}: проиграно ${candles.length} минуток простоя → сделок-BF закрыто ${bf.length} (${bfNet >= 0 ? '+' : ''}${bfNet.toFixed(2)}$)`,
      undefined, 'ensemble',
    );
  }

  /** Вызывается движком на каждом живом тике. Всё в памяти, БД — только на филлах/закрытиях. */
  async onQuote(q: Quote): Promise<void> {
    if (!this.running || this.replaying) return;
    await this.processQuote(q);
  }

  private async processQuote(q: Quote): Promise<void> {
    // разрыв котировок (ночь/выходные MOEX): протестированная модель не несёт
    // позиции через гэп — закрываем по первой цене после разрыва, как в свипе
    const gapMs = (this.cfg.gapCloseMin ?? 0) * 60_000;
    if (gapMs > 0 && this.lastQuoteAt && q.time.getTime() - this.lastQuoteAt > gapMs) {
      for (const m of this.members) {
        m.pending = [];
        for (const o of m.open) {
          const exit = o.side === 'BUY' ? q.bid : q.ask;
          const closeUnits = m.member.params.units * (o.mult ?? 1);
          const commission = (this.cfg.commissionFrac ?? 0) * o.entry * closeUnits;
          const pnl = (o.side === 'BUY' ? exit - o.entry : o.entry - exit) * closeUnits - commission;
          await this.deps.store.closeTradeById(o.rowId, { exitPrice: exit, closedAt: q.time, pnl, closeReason: 'GAP' });
          m.realizedToday += pnl;
          m.winStreakToday = pnl > 0 ? m.winStreakToday + 1 : 0;
          this.emitTrade({
            kind: 'close', memberKey: m.member.key, baseSymbol: this.cfg.baseSymbol, rowId: o.rowId,
            side: o.side, price: exit, pnl, reason: 'GAP', time: q.time,
          });
        }
        m.open = [];
      }
    }
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
      m.winStreakToday = 0; // лесенка hot-hand сбрасывается к утру
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
        // hot-hand: множитель фиксируется в момент открытия позиции (= филла),
        // как openedAt в оверлее бэктеста
        const mult = m.hhMult();
        const row = await this.deps.store.openTrade({
          mode: MODE,
          symbol: m.symbol(),
          side: pe.side,
          units: p.units * mult,
          entryPrice: pe.price,
          slPrice: pe.sl,
          tpPrice: pe.tp,
          openedAt: q.time,
          costSpread: 0,
          costCommission: 0,
          brokerTradeId: this.backfillTag,
          spreadAtEntry: spreadPips,
          volAtEntry: m.strategy.windowRangePips(),
          hourUtc: q.time.getUTCHours(),
          newsDistMin: null,
          paramsSnapshot: p,
        });
        m.open.push({ rowId: row.id, side: pe.side, entry: pe.price, tp: pe.tp, sl: pe.sl, openedAt: q.time.getTime(), mult });
        m.tradesToday += 1;
        this.emitTrade({
          kind: 'open', memberKey: m.member.key, baseSymbol: this.cfg.baseSymbol, rowId: row.id,
          side: pe.side, price: pe.price, tp: pe.tp, sl: pe.sl, time: q.time,
        });
      }
      m.pending = keep;
    }

    // 2) TP/SL открытых (оба задеты в одном тике — невозможно: тик один)
    if (m.open.length) {
      const keep: VOpen[] = [];
      for (const o of m.open) {
        let exit: number | null = null;
        let reason = '';
        const dir = o.side === 'BUY' ? 1 : -1;
        const px = o.side === 'BUY' ? q.bid : q.ask; // выход всегда по пассивной стороне
        if (o.trailing) {
          // трейл взведён: TP/SL больше не смотрим — ведём пик и ловим откат
          // на frac·(TP-дистанции). Худший исход BUY: peak ≥ tp → выход ≥
          // entry+(1−frac)·dist, т.е. трейл никогда не отдаёт сделку в минус.
          o.peak = dir === 1 ? Math.max(o.peak ?? o.tp, px) : Math.min(o.peak ?? o.tp, px);
          const trail = o.peak - dir * p.trailAfterTpFrac * Math.abs(o.tp - o.entry);
          if (dir * (px - trail) <= 0) { exit = trail; reason = 'TRAIL'; }
        } else if (dir * (px - o.sl) <= 0) {
          exit = o.sl; reason = 'SL';
        } else if (dir * (px - o.tp) >= 0) {
          if (p.trailAfterTpFrac > 0) {
            // идея владельца 22.08: цель тронута — не фиксируем, взводим трейлинг
            o.trailing = true;
            o.peak = px;
          } else { exit = o.tp; reason = 'TP'; }
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
        const closeUnits = m.member.params.units * (o.mult ?? 1);
        const commission = (this.cfg.commissionFrac ?? 0) * o.entry * closeUnits;
        const pnl = (o.side === 'BUY' ? exit - o.entry : o.entry - exit) * closeUnits - commission;
        await this.deps.store.closeTradeById(o.rowId, {
          exitPrice: exit,
          closedAt: q.time,
          pnl,
          closeReason: o.beLocked && exit === o.entry ? 'BE' : reason,
        });
        m.realizedToday += pnl;
        m.winStreakToday = pnl > 0 ? m.winStreakToday + 1 : 0; // лесенка hot-hand
        this.emitTrade({
          kind: 'close', memberKey: m.member.key, baseSymbol: this.cfg.baseSymbol, rowId: o.rowId,
          side: o.side, price: exit, pnl,
          reason: o.beLocked && exit === o.entry ? 'BE' : reason, time: q.time,
        });
      }
      m.open = keep;
    }

    // 3) новый сигнал → виртуальная лимитка (страддлов в ростере нет)
    const sig = m.strategy.onQuote(q);
    if (!sig || sig.both) return;
    // дневной профит-стоп (A/B-гипотеза 05.08): цель достигнута → входов до завтра нет
    if (p.dailyProfitStopUsd > 0 && m.realizedToday >= p.dailyProfitStopUsd) return;
    // внешний гейт (oilguard-клоны): вход не разрешён — сигнал пропускается
    if (this.cfg.entryGuard && !this.cfg.entryGuard(m.member.key, sig.side, q.time)) return;
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
      const mult = m.hhMult();
      const entry = sig.side === 'BUY' ? q.ask : q.bid;
      const tp = round5(sig.side === 'BUY' ? entry + sig.tpPips * PIP : entry - sig.tpPips * PIP);
      const sl = round5(sig.side === 'BUY' ? entry - sig.slPips * PIP : entry + sig.slPips * PIP);
      const row = await this.deps.store.openTrade({
        mode: MODE,
        symbol: m.symbol(),
        side: sig.side,
        units: p.units * mult,
        entryPrice: entry,
        slPrice: sl,
        tpPrice: tp,
        openedAt: q.time,
        costSpread: (q.ask - q.bid) * p.units * mult,
        costCommission: 0,
        brokerTradeId: this.backfillTag,
        spreadAtEntry: spreadPips,
        volAtEntry: m.strategy.windowRangePips(),
        hourUtc: q.time.getUTCHours(),
        newsDistMin: null,
        paramsSnapshot: p,
      });
      m.open.push({ rowId: row.id, side: sig.side, entry, tp, sl, openedAt: q.time.getTime(), mult });
      m.tradesToday += 1;
      this.emitTrade({
        kind: 'open', memberKey: m.member.key, baseSymbol: this.cfg.baseSymbol, rowId: row.id,
        side: sig.side, price: entry, tp, sl, time: q.time,
      });
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
      hotStreak: number | null; // подряд плюсов сегодня (только у hot-hand-клонов)
      bf14: number; // сделок-догонок (BF) из 14-дневного окна — в лицензии не входят
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
        // лицензия строго по ЖИВЫМ тикам: сделки-догонки (BF) — модельные филлы,
        // они дают картину срабатываний, но допуск к деньгам не аргументируют
        const live = mine.filter(t => t.brokerTradeId !== 'BF');
        const liveNet = live.reduce((s, t) => s + (t.pnl ?? 0), 0);
        const license = live.length >= 10 ? (liveNet > 0 ? 'granted' as const : 'denied' as const) : 'collecting' as const;
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
          hotStreak: m.member.params.hotHandLadder ? m.winStreakToday : null,
          bf14: mine.length - live.length,
          license,
        };
      }),
    };
  }
}
