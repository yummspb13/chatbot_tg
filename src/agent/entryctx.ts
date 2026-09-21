// Контекст входа: что рынок делал ДО сделки. Пишется в agent_Trade.entryCtx (jsonb)
// рядом со spreadAtEntry/volAtEntry/hourUtc, в пипсах масштабированного
// пространства ноги (тот же PIP, что у спреда и волы окна).
//
// Добавлено 21.09.2026 по итогам P(win | условия) (docs/PWIN-2026-09-21.md):
// записанные условия входа (спред, вола окна, час, день, сторона) не несли
// OOS-информации сверх частоты ячейки. Копим более сильные условия — ход и
// размах за 1/4/24 часа, положение в суточном диапазоне, разрыв котировок,
// новостной балл, нефтяной шок — чтобы вернуться к P(win) через 2-3 месяца
// форварда. Только запись: на торговые решения ничего из этого не влияет.

import { PIP } from '../broker/types';

export interface EntryCtx {
  ret60: number | null;   // ход за 60 мин, пипсы (mid сейчас − mid 60 мин назад)
  ret240: number | null;  // ход за 4 часа
  ret1440: number | null; // ход за 24 часа
  rng60: number | null;   // размах max−min за 60 мин
  rng1440: number | null; // размах за 24 часа
  pos1440: number | null; // положение цены в 24-часовом диапазоне, 0..1
  gapMin: number | null;  // минут от предыдущей котировки ноги (разрыв сессии/данных)
  // расширения владельца ноги: news — балл новостного фона по активу,
  // oilShock — знак нефтяного шока (−1/0/1) для РФ-нефтянки и WTI
  [k: string]: number | null;
}

const SAMPLE_MS = 30_000;          // даунсемпл кольца
const HORIZON_MS = 25 * 3600_000;  // глубина кольца: сутки + запас

export class PriceContext {
  private ring: Array<{ t: number; mid: number }> = [];
  private prevQuoteT = 0;
  private lastGapMin: number | null = null;

  /** История прогрева (свечи): только в кольцо, без учёта разрывов. */
  seed(t: number, mid: number): void {
    this.push(t, mid);
  }

  /** Живая/проигранная котировка ноги: разрыв от предыдущей + кольцо. */
  onQuote(t: number, mid: number): void {
    this.lastGapMin = this.prevQuoteT ? (t - this.prevQuoteT) / 60_000 : null;
    this.prevQuoteT = t;
    this.push(t, mid);
  }

  private push(t: number, mid: number): void {
    if (!Number.isFinite(t) || !Number.isFinite(mid)) return;
    const last = this.ring[this.ring.length - 1];
    if (last && t - last.t < SAMPLE_MS) return; // в пределах 30с — первый сэмпл остаётся
    this.ring.push({ t, mid });
    const cutoff = t - HORIZON_MS;
    let drop = 0;
    while (drop < this.ring.length && this.ring[drop].t < cutoff) drop++;
    if (drop) this.ring.splice(0, drop);
  }

  /** mid последнего сэмпла не позже t−backMs, если он не старше целевого момента на tolMs. */
  private at(t: number, backMs: number, tolMs: number): number | null {
    const target = t - backMs;
    let lo = 0, hi = this.ring.length - 1, idx = -1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (this.ring[m].t <= target) { idx = m; lo = m + 1; } else hi = m - 1;
    }
    if (idx < 0) return null;
    const s = this.ring[idx];
    return target - s.t <= tolMs ? s.mid : null;
  }

  /** min/max за окно; null, если история покрывает меньше 80% окна. */
  private range(t: number, backMs: number): { min: number; max: number } | null {
    const from = t - backMs;
    let min = Infinity, max = -Infinity, oldest = t;
    for (let i = this.ring.length - 1; i >= 0 && this.ring[i].t >= from; i--) {
      const m = this.ring[i].mid;
      if (m < min) min = m;
      if (m > max) max = m;
      oldest = this.ring[i].t;
    }
    if (min === Infinity || t - oldest < 0.8 * backMs) return null;
    return { min, max };
  }

  /** Контекст на момент входа t при цене mid. Всё в пипсах (pip = PIP по умолчанию). */
  ctx(t: number, mid: number, pip = PIP): EntryCtx {
    const H = 3600_000;
    const ret = (back: number, tol: number) => {
      const m = this.at(t, back, tol);
      return m === null ? null : +((mid - m) / pip).toFixed(2);
    };
    const rng = (back: number) => {
      const r = this.range(t, back);
      return r ? +((r.max - r.min) / pip).toFixed(2) : null;
    };
    const r24 = this.range(t, 24 * H);
    return {
      ret60: ret(H, 5 * 60_000),
      ret240: ret(4 * H, 15 * 60_000),
      ret1440: ret(24 * H, 30 * 60_000),
      rng60: rng(H),
      rng1440: rng(24 * H),
      pos1440: r24 && r24.max > r24.min ? +Math.min(1, Math.max(0, (mid - r24.min) / (r24.max - r24.min))).toFixed(3) : null,
      gapMin: this.lastGapMin === null ? null : +this.lastGapMin.toFixed(1),
    };
  }

  size(): number {
    return this.ring.length;
  }
}
