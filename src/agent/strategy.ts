// Momentum-стратегия: если цена прошла > thresholdPips за windowSec — входим по направлению.
// Тот же код работает и вживую (тики), и в бэктесте (M1-свечи через onQuote).

import { PIP, Quote, Side } from '../broker/types';
import { AgentParams } from './params';

export interface Signal {
  side: Side;
  tpPips: number;
  slPips: number;
  reason: string;
}

export class MomentumStrategy {
  private window: { t: number; mid: number }[] = [];
  private cooldownUntil = 0;

  constructor(private params: AgentParams) {}

  updateParams(p: AgentParams): void {
    this.params = p;
  }

  reset(): void {
    this.window = [];
    this.cooldownUntil = 0;
  }

  /** Диапазон окна в pips — «волатильность на входе» для памяти агента. */
  windowRangePips(): number {
    if (this.window.length < 2) return 0;
    let min = Infinity, max = -Infinity;
    for (const w of this.window) {
      if (w.mid < min) min = w.mid;
      if (w.mid > max) max = w.mid;
    }
    return (max - min) / PIP;
  }

  onQuote(q: Quote): Signal | null {
    const t = q.time.getTime();
    const mid = (q.bid + q.ask) / 2;

    this.window.push({ t, mid });
    const cutoff = t - this.params.windowSec * 1000;
    while (this.window.length && this.window[0].t < cutoff) this.window.shift();

    if (t < this.cooldownUntil) return null;
    if (this.window.length < 2) return null;

    const span = t - this.window[0].t;
    if (span < this.params.windowSec * 1000 * 0.5) return null; // окно ещё не наполнилось

    const deltaPips = (mid - this.window[0].mid) / PIP;
    if (Math.abs(deltaPips) < this.params.thresholdPips) return null;

    this.cooldownUntil = t + this.params.cooldownSec * 1000;
    return {
      side: deltaPips > 0 ? 'BUY' : 'SELL',
      tpPips: this.params.tpPips,
      slPips: this.params.slPips,
      reason: `momentum ${deltaPips.toFixed(1)}p за ${Math.round(span / 1000)}с`,
    };
  }
}
