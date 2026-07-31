// Риск-модуль: жёсткие ворота перед каждым входом + kill-switch по дневному убытку.

import { AgentParams } from './params';

export interface RiskContext {
  now: Date;
  openCount: number;
  tradesToday: number;
  plToday: number; // реализованный за день + нереализованный сейчас, USD
  spreadPips: number;
  newsBlackout: boolean;
  crypto?: boolean; // крипто-CFD торгуются 24/7 — блок FX-выходных не применяется
}

export type RiskVerdict = { ok: true } | { ok: false; reason: string };

/** FX закрыт: с пятницы 20:45 UTC до воскресенья 21:15 UTC (запас на DST). */
export function isFxWeekend(now: Date): boolean {
  const day = now.getUTCDay();
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (day === 6) return true;
  if (day === 5 && mins >= 20 * 60 + 45) return true;
  if (day === 0 && mins < 21 * 60 + 15) return true;
  return false;
}

export class RiskManager {
  constructor(private params: AgentParams) {}

  updateParams(p: AgentParams): void {
    this.params = p;
  }

  check(ctx: RiskContext): RiskVerdict {
    const p = this.params;
    if (!ctx.crypto && isFxWeekend(ctx.now)) return { ok: false, reason: 'FX закрыт (выходные)' };
    if (ctx.newsBlackout) return { ok: false, reason: 'новостное окно' };
    if (p.autoBlackoutHours.includes(ctx.now.getUTCHours())) {
      return { ok: false, reason: `авто-блэкаут часа ${ctx.now.getUTCHours()}:00 UTC` };
    }
    if (p.tradeHoursUtc.length && !p.tradeHoursUtc.includes(ctx.now.getUTCHours())) {
      return { ok: false, reason: `час ${ctx.now.getUTCHours()}:00 UTC вне торговых часов [${p.tradeHoursUtc.join(',')}]` };
    }
    if (ctx.spreadPips > p.spreadGuardPips) {
      return { ok: false, reason: `спред ${ctx.spreadPips.toFixed(1)}p > лимита ${p.spreadGuardPips}p` };
    }
    if (ctx.openCount >= p.maxConcurrent) {
      return { ok: false, reason: `открыто позиций ${ctx.openCount} ≥ лимита ${p.maxConcurrent}` };
    }
    if (ctx.tradesToday >= p.maxTradesPerDay) {
      return { ok: false, reason: `сделок за день ${ctx.tradesToday} ≥ лимита ${p.maxTradesPerDay}` };
    }
    if (ctx.plToday <= -p.maxDailyLossUsd) {
      return { ok: false, reason: `дневной убыток ${ctx.plToday.toFixed(2)}$ достиг лимита` };
    }
    return { ok: true };
  }

  shouldKill(plToday: number): boolean {
    return plToday <= -this.params.maxDailyLossUsd;
  }
}
