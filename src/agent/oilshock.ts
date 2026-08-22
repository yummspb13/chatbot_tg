// Трекер нефтяного шока для oilguard-клона SIBN (батч 22.08: 12/12 вариантов
// фильтра лучше базы на тесте июнь-август — режим «нефтянка ходит за нефтью»).
// Лучший вариант батча: БЛОК ВСЕХ входов 60 минут после часового |хода| WTI
// > 2σ (тест ячейки 22.4$ → 129.1$). σ зафиксирована константой из train-окна
// батча (данные до 2026-06) — на лету не переучивается, ворота не двигаем.
// Fail-open: нет данных нефти (стрим упал/выходные) — входы разрешены.

export class OilShockTracker {
  /** σ часового лог-хода WTI по train-окну батча 22.08 */
  static readonly SIGMA_60M = 0.00568;
  static readonly K_SIGMA = 2;
  static readonly MEMORY_MS = 60 * 60_000;

  private ring: Array<{ t: number; mid: number }> = [];
  private lastShock: { t: number; sign: number } | null = null;
  private lastQuoteAt = 0;

  /** Кормится реальной ценой WTI из мультирыночного стрима (даунсемпл 30с). */
  onQuote(mid: number, time: Date): void {
    const ts = time.getTime();
    this.lastQuoteAt = ts;
    const last = this.ring[this.ring.length - 1];
    if (last && ts - last.t < 30_000) return;
    this.ring.push({ t: ts, mid });
    while (this.ring.length && this.ring[0].t < ts - 3 * 3600_000) this.ring.shift();
    // опорная точка ~час назад (допуск ±5 мин); нет точки — шок не меряем
    const target = ts - 60 * 60_000;
    let ref: { t: number; mid: number } | null = null;
    for (const p of this.ring) {
      if (p.t <= target + 5 * 60_000) ref = p;
      else break;
    }
    if (!ref || Math.abs(ref.t - target) > 5 * 60_000) return;
    const r = Math.log(mid / ref.mid);
    if (Math.abs(r) > OilShockTracker.K_SIGMA * OilShockTracker.SIGMA_60M) {
      this.lastShock = { t: ts, sign: Math.sign(r) };
    }
  }

  /** Знак активного шока (часовой |ход| > 2σ за последние 60 мин), иначе 0. */
  shockSign(now = Date.now()): number {
    return this.lastShock && now - this.lastShock.t <= OilShockTracker.MEMORY_MS
      ? this.lastShock.sign
      : 0;
  }

  summary(): { active: number; lastShockAgoMin: number | null; oilQuoteAgoSec: number | null } {
    return {
      active: this.shockSign(),
      lastShockAgoMin: this.lastShock ? Math.round((Date.now() - this.lastShock.t) / 60_000) : null,
      oilQuoteAgoSec: this.lastQuoteAt ? Math.round((Date.now() - this.lastQuoteAt) / 1000) : null,
    };
  }
}
