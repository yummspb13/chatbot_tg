// «Обучение», часть 1: ночной пересчёт статистики по часам (UTC) за 30 дней.
// Стабильно убыточные часы (достаточно сделок + отрицательное ожидание)
// попадают в params.autoBlackoutHours — прозрачно, видно в логах/PWA, обратимо.

import { errMsg, log } from '../logger';
import { AgentEngine } from '../agent/engine';
import type { TradeStore } from '../store';

export interface HourBucket {
  hour: number;
  n: number;
  pnl: number;
  expectancy: number; // USD на сделку
}

const MIN_TRADES_PER_BUCKET = 10;
const MIN_BUCKET_LOSS_USD = 1;
const MAX_BLACKOUT_HOURS = 6;

export async function computeHourStats(store: TradeStore, mode: string, days: number): Promise<HourBucket[]> {
  const since = new Date(Date.now() - days * 86400_000);
  const trades = await store.closedTradesSince(mode, since);
  const buckets = new Map<number, { n: number; pnl: number }>();
  for (const t of trades) {
    const hour = t.hourUtc ?? t.openedAt.getUTCHours();
    const b = buckets.get(hour) ?? { n: 0, pnl: 0 };
    b.n += 1;
    b.pnl += t.pnl ?? 0;
    buckets.set(hour, b);
  }
  return [...buckets.entries()]
    .map(([hour, b]) => ({ hour, n: b.n, pnl: b.pnl, expectancy: b.pnl / b.n }))
    .sort((a, b) => a.hour - b.hour);
}

export async function runNightlyLearning(
  store: TradeStore,
  engine: AgentEngine,
  notify: (text: string) => Promise<void>,
): Promise<void> {
  try {
    const settings = await store.getSettings();
    const stats = await computeHourStats(store, settings.mode, 30);
    if (!stats.length) return;

    const bad = stats
      .filter(b => b.n >= MIN_TRADES_PER_BUCKET && b.expectancy < 0 && b.pnl <= -MIN_BUCKET_LOSS_USD)
      .sort((a, b) => a.expectancy - b.expectancy)
      .slice(0, MAX_BLACKOUT_HOURS)
      .map(b => b.hour);

    const current = [...settings.params.autoBlackoutHours].sort((a, b) => a - b);
    const next = [...bad].sort((a, b) => a - b);
    if (JSON.stringify(current) === JSON.stringify(next)) return;

    await engine.applyParams({ autoBlackoutHours: next });
    const text = next.length
      ? `🧠 Обучение: авто-блэкаут часов UTC [${next.join(', ')}] — за 30 дней там стабильный минус `
        + `(${next.map(h => { const b = stats.find(x => x.hour === h); return b ? `${h}:00 → ${b.pnl.toFixed(2)}$/${b.n}сд` : `${h}:00`; }).join('; ')}). `
        + 'Отключить: /agent_params (autoBlackoutHours управляется обучением).'
      : '🧠 Обучение: авто-блэкаут часов снят — устойчиво убыточных часов за 30 дней не найдено.';
    log.info(text, undefined, 'learn');
    await notify(text);
  } catch (e) {
    log.warn(`nightly learning: ${errMsg(e)}`, undefined, 'learn');
  }
}
