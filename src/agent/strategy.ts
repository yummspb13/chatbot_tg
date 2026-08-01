// Стратегии. Обе работают и вживую (тики), и в бэктесте (M1-свечи) через onQuote.
//
// momentum: цена прошла > thresholdPips за windowSec → вход ПО направлению.
// meanrev:  цена отклонилась > thresholdPips от среднего за windowSec → вход ПРОТИВ
//           (ставка на возврат к среднему; исторически на минутках EUR/USD
//           выражен сильнее momentum, особенно в тихие часы).

import { PIP, Quote, Side } from '../broker/types';
import { AgentParams } from './params';

export interface Signal {
  side: Side;
  tpPips: number;
  slPips: number;
  reason: string;
  /** straddle: ставить ОБЕ стороны (side тогда номинален) */
  both?: boolean;
}

export interface TradingStrategy {
  onQuote(q: Quote): Signal | null;
  updateParams(p: AgentParams): void;
  windowRangePips(): number;
  reset(): void;
}

abstract class WindowStrategy implements TradingStrategy {
  protected window: { t: number; mid: number }[] = [];
  protected cooldownUntil = 0;

  constructor(protected params: AgentParams) {}

  updateParams(p: AgentParams): void {
    this.params = p;
  }

  reset(): void {
    this.window = [];
    this.cooldownUntil = 0;
  }

  windowRangePips(): number {
    if (this.window.length < 2) return 0;
    let min = Infinity, max = -Infinity;
    for (const w of this.window) {
      if (w.mid < min) min = w.mid;
      if (w.mid > max) max = w.mid;
    }
    return (max - min) / PIP;
  }

  protected push(q: Quote): { t: number; mid: number } {
    const t = q.time.getTime();
    const mid = (q.bid + q.ask) / 2;
    this.window.push({ t, mid });
    const cutoff = t - this.params.windowSec * 1000;
    while (this.window.length && this.window[0].t < cutoff) this.window.shift();
    return { t, mid };
  }

  protected windowReady(t: number): boolean {
    if (t < this.cooldownUntil) return false;
    if (this.window.length < 2) return false;
    const span = t - this.window[0].t;
    return span >= this.params.windowSec * 1000 * 0.5;
  }

  abstract onQuote(q: Quote): Signal | null;
}

export class MomentumStrategy extends WindowStrategy {
  onQuote(q: Quote): Signal | null {
    const { t, mid } = this.push(q);
    if (!this.windowReady(t)) return null;

    const deltaPips = (mid - this.window[0].mid) / PIP;
    if (Math.abs(deltaPips) < this.params.thresholdPips) return null;

    this.cooldownUntil = t + this.params.cooldownSec * 1000;
    return {
      side: deltaPips > 0 ? 'BUY' : 'SELL',
      tpPips: this.params.tpPips,
      slPips: this.params.slPips,
      reason: `momentum ${deltaPips.toFixed(1)}p за ${Math.round((t - this.window[0].t) / 1000)}с`,
    };
  }
}

export class MeanReversionStrategy extends WindowStrategy {
  onQuote(q: Quote): Signal | null {
    const { t, mid } = this.push(q);
    if (!this.windowReady(t)) return null;

    let sum = 0;
    for (const w of this.window) sum += w.mid;
    const mean = sum / this.window.length;
    const devPips = (mid - mean) / PIP;
    if (Math.abs(devPips) < this.params.thresholdPips) return null;

    this.cooldownUntil = t + this.params.cooldownSec * 1000;
    // отклонение вверх → SELL (ждём возврата вниз), и наоборот
    return {
      side: devPips > 0 ? 'SELL' : 'BUY',
      tpPips: this.params.tpPips,
      slPips: this.params.slPips,
      reason: `meanrev ${devPips.toFixed(1)}p от среднего за ${Math.round(this.params.windowSec / 60)}м`,
    };
  }
}

/** Сэмплер минутных закрытий: и живые тики, и M1-бэктест дают ОДИНАКОВЫЙ ряд. */
class MinuteSampler {
  private bucket = -1;
  private lastMid = 0;

  push(t: number, mid: number): { t: number; mid: number } | null {
    const b = Math.floor(t / 60_000);
    if (this.bucket === -1) {
      this.bucket = b;
      this.lastMid = mid;
      return null;
    }
    if (b === this.bucket) {
      this.lastMid = mid;
      return null;
    }
    const out = { t: this.bucket * 60_000 + 60_000, mid: this.lastMid };
    this.bucket = b;
    this.lastMid = mid;
    return out;
  }

  reset(): void {
    this.bucket = -1;
  }
}

/**
 * АВТОРСКАЯ стратегия «Асимметрия импульсов» (путь наименьшего сопротивления).
 *
 * Идея: направление цены и ХАРАКТЕР движения — разные вещи. Разбиваем окно на
 * «ноги» — непрерывные пробеги минутных закрытий вверх/вниз. Если средняя нога
 * вниз систематически длиннее средней ноги вверх, падения импульсные, а подъёмы
 * вымученные → под ценой мало ликвидности, путь наименьшего сопротивления вниз.
 * Формула: asym = avgLegDown − avgLegUp (pips); asym ≥ порога → SELL, ≤ −порога → BUY.
 * Это вход не «куда шла цена», а «куда ей легче идти».
 */
export class ImpulseAsymmetryStrategy implements TradingStrategy {
  private sampler = new MinuteSampler();
  private minutes: { t: number; mid: number }[] = [];
  private cooldownUntil = 0;

  constructor(private params: AgentParams) {}

  updateParams(p: AgentParams): void {
    this.params = p;
  }

  reset(): void {
    this.sampler.reset();
    this.minutes = [];
    this.cooldownUntil = 0;
  }

  windowRangePips(): number {
    if (this.minutes.length < 2) return 0;
    let min = Infinity, max = -Infinity;
    for (const m of this.minutes) {
      if (m.mid < min) min = m.mid;
      if (m.mid > max) max = m.mid;
    }
    return (max - min) / PIP;
  }

  onQuote(q: Quote): Signal | null {
    const m = this.sampler.push(q.time.getTime(), (q.bid + q.ask) / 2);
    if (!m) return null;

    this.minutes.push(m);
    const cutoff = m.t - this.params.windowSec * 1000;
    while (this.minutes.length && this.minutes[0].t < cutoff) this.minutes.shift();

    if (m.t < this.cooldownUntil) return null;
    if (this.minutes.length < 20) return null;

    const upLegs: number[] = [];
    const dnLegs: number[] = [];
    let dir = 0;
    let acc = 0;
    for (let i = 1; i < this.minutes.length; i++) {
      const d = this.minutes[i].mid - this.minutes[i - 1].mid;
      if (d === 0) continue;
      const s = d > 0 ? 1 : -1;
      if (s === dir) {
        acc += Math.abs(d);
      } else {
        if (dir === 1) upLegs.push(acc);
        else if (dir === -1) dnLegs.push(acc);
        dir = s;
        acc = Math.abs(d);
      }
    }
    if (dir === 1) upLegs.push(acc);
    else if (dir === -1) dnLegs.push(acc);

    if (upLegs.length < 3 || dnLegs.length < 3) return null;

    const avgUp = upLegs.reduce((a, b) => a + b, 0) / upLegs.length / PIP;
    const avgDn = dnLegs.reduce((a, b) => a + b, 0) / dnLegs.length / PIP;
    const asym = avgDn - avgUp;
    if (Math.abs(asym) < this.params.thresholdPips) return null;

    this.cooldownUntil = m.t + this.params.cooldownSec * 1000;
    return {
      side: asym > 0 ? 'SELL' : 'BUY',
      tpPips: this.params.tpPips,
      slPips: this.params.slPips,
      reason: `impulse: асимметрия ${asym.toFixed(1)}p (ноги ↓${avgDn.toFixed(1)}p×${dnLegs.length} vs ↑${avgUp.toFixed(1)}p×${upLegs.length})`,
    };
  }
}

/**
 * АВТОРСКАЯ стратегия «Эхо часа» (возврат к собственному расписанию).
 *
 * Идея: у каждой пары есть внутридневной ритм (Азия/Лондон/Нью-Йорк). Строим
 * якорную кривую — медианный ход цены от открытия дня (00:00 UTC) к концу
 * каждого часа за последние 20 торговых дней. Если СЕГОДНЯ пара убежала от
 * своего расписания на ≥ thresholdPips — ставим на возврат к ритму (fade).
 * Прогрев: сигналы только после ≥5 накопленных дней наблюдений.
 */
export class HourEchoStrategy implements TradingStrategy {
  private sampler = new MinuteSampler();
  private recent: { t: number; mid: number }[] = [];
  private dayKey = '';
  private dayOpen = 0;
  private hourEnd: number[] = new Array(24).fill(NaN);
  private history: number[][] = [];
  private cooldownUntil = 0;

  constructor(private params: AgentParams) {}

  updateParams(p: AgentParams): void {
    this.params = p;
  }

  reset(): void {
    this.sampler.reset();
    this.recent = [];
    this.dayKey = '';
    this.dayOpen = 0;
    this.hourEnd = new Array(24).fill(NaN);
    this.history = [];
    this.cooldownUntil = 0;
  }

  windowRangePips(): number {
    if (this.recent.length < 2) return 0;
    let min = Infinity, max = -Infinity;
    for (const m of this.recent) {
      if (m.mid < min) min = m.mid;
      if (m.mid > max) max = m.mid;
    }
    return (max - min) / PIP;
  }

  /** Медиана дисплейсмента на конец часа h по накопленным дням (h<0 → 0). */
  private median(h: number): number {
    if (h < 0) return 0;
    const vals = this.history.map(c => c[h]).sort((a, b) => a - b);
    return vals.length ? vals[Math.floor(vals.length / 2)] : 0;
  }

  onQuote(q: Quote): Signal | null {
    const m = this.sampler.push(q.time.getTime(), (q.bid + q.ask) / 2);
    if (!m) return null;

    this.recent.push(m);
    const cutoff = m.t - 3600_000;
    while (this.recent.length && this.recent[0].t < cutoff) this.recent.shift();

    const d = new Date(m.t);
    const key = d.toISOString().slice(0, 10);
    const hour = d.getUTCHours();
    const frac = d.getUTCMinutes() / 60;

    if (key !== this.dayKey) {
      if (this.dayKey) {
        // завершённый день → в историю (пропуски часов заполняем последним значением)
        let filled = 0;
        let last = 0;
        const curve = this.hourEnd.map(v => {
          if (Number.isFinite(v)) {
            last = v;
            filled += 1;
          }
          return last;
        });
        if (filled >= 12) {
          this.history.push(curve);
          if (this.history.length > 20) this.history.shift();
        }
      }
      this.dayKey = key;
      this.dayOpen = m.mid;
      this.hourEnd = new Array(24).fill(NaN);
    }

    const disp = (m.mid - this.dayOpen) / PIP;
    this.hourEnd[hour] = disp;

    if (m.t < this.cooldownUntil) return null;
    if (this.history.length < 5) return null;

    const anchor = this.median(hour - 1) + (this.median(hour) - this.median(hour - 1)) * frac;
    const dev = disp - anchor;
    if (Math.abs(dev) < this.params.thresholdPips) return null;

    this.cooldownUntil = m.t + this.params.cooldownSec * 1000;
    return {
      side: dev > 0 ? 'SELL' : 'BUY',
      tpPips: this.params.tpPips,
      slPips: this.params.slPips,
      reason: `echo: отклонение ${dev.toFixed(1)}p от расписания (день ${disp.toFixed(1)}p vs якорь ${anchor.toFixed(1)}p)`,
    };
  }
}

/**
 * АВТОРСКАЯ стратегия «Страддл» (микро-маркетмейкер без прогноза).
 *
 * Идея: не угадывать направление вообще. В ТИХОМ рынке (диапазон окна ≤ порога)
 * выставляются обе лимитки сразу — buy у bid и sell у ask; дрожание цены
 * исполняет то одну, то другую, каждая закрывается маленьким TP. Заработок —
 * сбор рыночного шума, как это делают маркетмейкеры. Главный враг — тренд
 * (исполняет одну сторону и уводит цену дальше), поэтому thresholdPips здесь —
 * ВЕРХНЯЯ граница диапазона окна: рынок бежит → не ставим ничего.
 */
export class StraddleStrategy extends WindowStrategy {
  onQuote(q: Quote): Signal | null {
    const { t } = this.push(q);
    if (!this.windowReady(t)) return null;

    const rangePips = this.windowRangePips();
    if (rangePips > this.params.thresholdPips) return null; // рынок бежит — молчим

    this.cooldownUntil = t + this.params.cooldownSec * 1000;
    return {
      side: 'BUY', // номинально; both=true ставит обе стороны
      both: true,
      tpPips: this.params.tpPips,
      slPips: this.params.slPips,
      reason: `straddle: тихо (диапазон ${rangePips.toFixed(1)}p ≤ ${this.params.thresholdPips}p за ${Math.round(this.params.windowSec / 60)}м)`,
    };
  }
}

/**
 * АВТОРСКАЯ стратегия «Погода ликвидности» (спред как сигнал).
 *
 * Идея: торговать не по цене, а по ПОВЕДЕНИЮ СПРЕДА. Маркетмейкеры расширяют
 * спред, когда боятся — перед новостями, на рывках, при тонкой книге. Схема:
 * 1) базовая линия — медиана спреда за windowSec;
 * 2) «испуг»: спред ≥ 1.8× базы → запоминаем цену ДО испуга (якорь);
 * 3) «отбой»: спред вернулся ≤ 1.15× базы. Если цена к этому моменту осталась
 *    дальше thresholdPips от якоря — страх ушёл, а цена не вернулась → ставим
 *    на возврат к якорю (fade сдвига, случившегося на страхе).
 * Требует реального спреда: в бэктесте — loadM1WithSpread, вживую — bid/ask тика.
 */
export class SpreadWeatherStrategy implements TradingStrategy {
  private sampler = new MinuteSampler();
  private minutes: { t: number; mid: number; spreadPips: number }[] = [];
  private lastMinuteSpread = 0;
  private spikeAnchor: number | null = null; // mid до испуга
  private spikeStartT = 0;
  private cooldownUntil = 0;

  constructor(private params: AgentParams) {}

  updateParams(p: AgentParams): void {
    this.params = p;
  }

  reset(): void {
    this.sampler.reset();
    this.minutes = [];
    this.spikeAnchor = null;
    this.cooldownUntil = 0;
  }

  windowRangePips(): number {
    if (this.minutes.length < 2) return 0;
    let min = Infinity, max = -Infinity;
    for (const m of this.minutes) {
      if (m.mid < min) min = m.mid;
      if (m.mid > max) max = m.mid;
    }
    return (max - min) / PIP;
  }

  private baseline(): number {
    if (this.minutes.length < 30) return NaN;
    const s = this.minutes.map(m => m.spreadPips).sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  }

  onQuote(q: Quote): Signal | null {
    const spreadPips = (q.ask - q.bid) / PIP;
    // внутри минуты копим максимум спреда — испуг часто короче минуты
    this.lastMinuteSpread = Math.max(this.lastMinuteSpread, spreadPips);
    const m = this.sampler.push(q.time.getTime(), (q.bid + q.ask) / 2);
    if (!m) return null;
    const minuteSpread = this.lastMinuteSpread;
    this.lastMinuteSpread = spreadPips;

    const prev = this.minutes[this.minutes.length - 1] ?? null;
    this.minutes.push({ t: m.t, mid: m.mid, spreadPips: minuteSpread });
    const cutoff = m.t - this.params.windowSec * 1000;
    while (this.minutes.length && this.minutes[0].t < cutoff) this.minutes.shift();

    const base = this.baseline();
    if (!Number.isFinite(base) || base <= 0) return null;

    // начало испуга: запоминаем якорь (цену ПРЕДЫДУЩЕЙ, спокойной минуты)
    if (this.spikeAnchor === null && minuteSpread >= base * 1.8 && prev) {
      this.spikeAnchor = prev.mid;
      this.spikeStartT = m.t;
      return null;
    }
    if (this.spikeAnchor === null) return null;

    // испуг затянулся (>2ч) — якорь протух
    if (m.t - this.spikeStartT > 7200_000) {
      this.spikeAnchor = null;
      return null;
    }

    // отбой: спред вернулся к норме
    if (minuteSpread > base * 1.15) return null;
    const anchor = this.spikeAnchor;
    this.spikeAnchor = null;

    if (m.t < this.cooldownUntil) return null;
    const devPips = (m.mid - anchor) / PIP;
    if (Math.abs(devPips) < this.params.thresholdPips) return null;

    this.cooldownUntil = m.t + this.params.cooldownSec * 1000;
    // цена выше якоря → ставим на возврат вниз (SELL), и наоборот
    return {
      side: devPips > 0 ? 'SELL' : 'BUY',
      tpPips: this.params.tpPips,
      slPips: this.params.slPips,
      reason: `spreadweather: спред ${minuteSpread.toFixed(1)}p→норма (база ${base.toFixed(1)}p), цена ушла ${devPips.toFixed(1)}p от якоря`,
    };
  }
}

/**
 * УЧЕБНИКОВАЯ стратегия «Тренд + откат к скользящей» (matrend).
 *
 * Формализация классики, которую реально торгуют трендовые системы:
 * - режим: средняя EMA (windowSec) против медленной EMA (4×windowSec) и цены —
 *   торгуем ТОЛЬКО по направлению старшего тренда;
 * - вход: цена откатилась ПОД среднюю EMA на ≥ thresholdPips (не шум),
 *   затем вернулась над неё — покупаем откат в аптренде (зеркально в даун);
 * - выход: обычные TP/SL параметров.
 * Всё на минутных закрытиях (MinuteSampler) — паритет live/бэктест.
 */
export class MATrendStrategy implements TradingStrategy {
  private sampler = new MinuteSampler();
  private emaMid = NaN;
  private emaSlow = NaN;
  private wasBelowMid = false; // для BUY-сетапа: цена была под средней
  private wasAboveMid = false; // для SELL-сетапа
  private extremePips = 0;     // глубина отката от средней, pips
  private recent: { t: number; mid: number }[] = [];
  private cooldownUntil = 0;

  constructor(private params: AgentParams) {}

  updateParams(p: AgentParams): void {
    this.params = p;
  }

  reset(): void {
    this.sampler.reset();
    this.emaMid = NaN;
    this.emaSlow = NaN;
    this.wasBelowMid = false;
    this.wasAboveMid = false;
    this.extremePips = 0;
    this.recent = [];
    this.cooldownUntil = 0;
  }

  windowRangePips(): number {
    if (this.recent.length < 2) return 0;
    let min = Infinity, max = -Infinity;
    for (const m of this.recent) {
      if (m.mid < min) min = m.mid;
      if (m.mid > max) max = m.mid;
    }
    return (max - min) / PIP;
  }

  onQuote(q: Quote): Signal | null {
    const m = this.sampler.push(q.time.getTime(), (q.bid + q.ask) / 2);
    if (!m) return null;

    this.recent.push(m);
    const cutoff = m.t - 3600_000;
    while (this.recent.length && this.recent[0].t < cutoff) this.recent.shift();

    const nMid = Math.max(2, this.params.windowSec / 60);
    const aMid = 2 / (nMid + 1);
    const aSlow = 2 / (nMid * 4 + 1);
    this.emaMid = Number.isFinite(this.emaMid) ? this.emaMid + aMid * (m.mid - this.emaMid) : m.mid;
    this.emaSlow = Number.isFinite(this.emaSlow) ? this.emaSlow + aSlow * (m.mid - this.emaSlow) : m.mid;

    const upTrend = this.emaMid > this.emaSlow && m.mid > this.emaSlow;
    const dnTrend = this.emaMid < this.emaSlow && m.mid < this.emaSlow;
    const distPips = (m.mid - this.emaMid) / PIP; // >0 над средней

    let sig: Signal | null = null;
    if (m.t >= this.cooldownUntil) {
      // возврат над среднюю после отката достаточной глубины — вход по тренду
      if (upTrend && this.wasBelowMid && distPips >= 0 && this.extremePips >= this.params.thresholdPips) {
        sig = {
          side: 'BUY',
          tpPips: this.params.tpPips,
          slPips: this.params.slPips,
          reason: `matrend: откат ${this.extremePips.toFixed(1)}p к EMA в аптренде, возврат`,
        };
      } else if (dnTrend && this.wasAboveMid && distPips <= 0 && this.extremePips >= this.params.thresholdPips) {
        sig = {
          side: 'SELL',
          tpPips: this.params.tpPips,
          slPips: this.params.slPips,
          reason: `matrend: откат ${this.extremePips.toFixed(1)}p к EMA в даунтренде, возврат`,
        };
      }
    }

    // обновление состояния откатов ПОСЛЕ проверки сигнала; при смене стороны
    // глубина обнуляется (иначе экскурсия одной стороны засчитается другой)
    if (distPips < 0) {
      if (!this.wasBelowMid) {
        this.wasBelowMid = true;
        this.wasAboveMid = false;
        this.extremePips = 0;
      }
      this.extremePips = Math.max(this.extremePips, -distPips);
    } else if (distPips > 0) {
      if (!this.wasAboveMid) {
        this.wasAboveMid = true;
        this.wasBelowMid = false;
        this.extremePips = 0;
      }
      this.extremePips = Math.max(this.extremePips, distPips);
    }
    if (sig) {
      this.cooldownUntil = m.t + this.params.cooldownSec * 1000;
      this.wasBelowMid = false;
      this.wasAboveMid = false;
      this.extremePips = 0;
    }
    return sig;
  }
}

/**
 * УЧЕБНИКОВАЯ стратегия «Профиль сессии» (vprofile, Market Profile по времени).
 *
 * По минуткам ПРОШЛОЙ UTC-сессии строится профиль «сколько минут цена провела
 * в каждом 2-пипсовом бине»: POC (самый населённый бин) и границы 70%-зоны
 * (VAH/VAL). Сегодня торгуются ОТКАТЫ к этим уровням строго по направлению
 * старшего тренда (EMA windowSec против 4×windowSec, как в matrend):
 * аптренд + цена пришла сверху в зону уровня ±thresholdPips → BUY (зеркально
 * в даунтренде). Один вход на уровень в день. Объём не нужен — оригинальный
 * Market Profile временной, что честно для FX, где объёма не существует.
 */
export class SessionProfileStrategy implements TradingStrategy {
  private sampler = new MinuteSampler();
  private recent: { t: number; mid: number }[] = [];
  private emaMid = NaN;
  private emaSlow = NaN;
  private dayKey = '';
  private bins = new Map<number, number>(); // бин → минут (текущая сессия)
  private levels: { name: string; price: number }[] = []; // POC/VAH/VAL прошлой сессии
  private usedLevels = new Set<string>();
  private prevMid = NaN;
  private cooldownUntil = 0;

  private static BIN_PIPS = 2;

  constructor(private params: AgentParams) {}

  updateParams(p: AgentParams): void {
    this.params = p;
  }

  reset(): void {
    this.sampler.reset();
    this.recent = [];
    this.emaMid = NaN;
    this.emaSlow = NaN;
    this.dayKey = '';
    this.bins = new Map();
    this.levels = [];
    this.usedLevels = new Set();
    this.prevMid = NaN;
    this.cooldownUntil = 0;
  }

  windowRangePips(): number {
    if (this.recent.length < 2) return 0;
    let min = Infinity, max = -Infinity;
    for (const m of this.recent) {
      if (m.mid < min) min = m.mid;
      if (m.mid > max) max = m.mid;
    }
    return (max - min) / PIP;
  }

  /** POC и границы зоны, накрывающей 70% минут сессии. */
  private computeLevels(): { name: string; price: number }[] {
    if (this.bins.size < 30) return []; // куцая сессия — уровней нет
    const entries = [...this.bins.entries()].sort((a, b) => b[1] - a[1]);
    const total = entries.reduce((s, [, n]) => s + n, 0);
    const binPrice = (b: number) => b * SessionProfileStrategy.BIN_PIPS * PIP;
    let acc = 0;
    const inVa: number[] = [];
    for (const [bin, n] of entries) {
      inVa.push(bin);
      acc += n;
      if (acc >= total * 0.7) break;
    }
    return [
      { name: 'POC', price: binPrice(entries[0][0]) },
      { name: 'VAH', price: binPrice(Math.max(...inVa)) },
      { name: 'VAL', price: binPrice(Math.min(...inVa)) },
    ];
  }

  onQuote(q: Quote): Signal | null {
    const m = this.sampler.push(q.time.getTime(), (q.bid + q.ask) / 2);
    if (!m) return null;

    this.recent.push(m);
    const cutoff = m.t - 3600_000;
    while (this.recent.length && this.recent[0].t < cutoff) this.recent.shift();

    const nMid = Math.max(2, this.params.windowSec / 60);
    const aMid = 2 / (nMid + 1);
    const aSlow = 2 / (nMid * 4 + 1);
    this.emaMid = Number.isFinite(this.emaMid) ? this.emaMid + aMid * (m.mid - this.emaMid) : m.mid;
    this.emaSlow = Number.isFinite(this.emaSlow) ? this.emaSlow + aSlow * (m.mid - this.emaSlow) : m.mid;

    // смена UTC-сессии: профиль дня уходит в уровни, счётчики обнуляются
    const day = new Date(m.t).toISOString().slice(0, 10);
    if (day !== this.dayKey) {
      if (this.dayKey) this.levels = this.computeLevels();
      this.dayKey = day;
      this.bins = new Map();
      this.usedLevels = new Set();
    }
    const bin = Math.round(m.mid / (SessionProfileStrategy.BIN_PIPS * PIP));
    this.bins.set(bin, (this.bins.get(bin) ?? 0) + 1);

    const prev = this.prevMid;
    this.prevMid = m.mid;
    if (!Number.isFinite(prev) || !this.levels.length || m.t < this.cooldownUntil) return null;

    const upTrend = this.emaMid > this.emaSlow && m.mid > this.emaSlow;
    const dnTrend = this.emaMid < this.emaSlow && m.mid < this.emaSlow;
    if (!upTrend && !dnTrend) return null;

    const tol = this.params.thresholdPips * PIP;
    for (const lv of this.levels) {
      if (this.usedLevels.has(lv.name)) continue;
      const inZone = Math.abs(m.mid - lv.price) <= tol;
      if (!inZone) continue;
      // подход к уровню против хода тренда: сверху в аптренде, снизу в даунтренде
      if (upTrend && prev > lv.price + tol) {
        this.usedLevels.add(lv.name);
        this.cooldownUntil = m.t + this.params.cooldownSec * 1000;
        return {
          side: 'BUY',
          tpPips: this.params.tpPips,
          slPips: this.params.slPips,
          reason: `vprofile: откат к ${lv.name} прошлой сессии в аптренде`,
        };
      }
      if (dnTrend && prev < lv.price - tol) {
        this.usedLevels.add(lv.name);
        this.cooldownUntil = m.t + this.params.cooldownSec * 1000;
        return {
          side: 'SELL',
          tpPips: this.params.tpPips,
          slPips: this.params.slPips,
          reason: `vprofile: откат к ${lv.name} прошлой сессии в даунтренде`,
        };
      }
    }
    return null;
  }
}

export function buildStrategy(params: AgentParams): TradingStrategy {
  switch (params.strategyType) {
    case 'meanrev': return new MeanReversionStrategy(params);
    case 'impulse': return new ImpulseAsymmetryStrategy(params);
    case 'echo': return new HourEchoStrategy(params);
    case 'straddle': return new StraddleStrategy(params);
    case 'spreadweather': return new SpreadWeatherStrategy(params);
    case 'matrend': return new MATrendStrategy(params);
    case 'vprofile': return new SessionProfileStrategy(params);
    default: return new MomentumStrategy(params);
  }
}
