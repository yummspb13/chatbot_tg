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

export function buildStrategy(params: AgentParams): TradingStrategy {
  return params.strategyType === 'meanrev'
    ? new MeanReversionStrategy(params)
    : new MomentumStrategy(params);
}
