// Экономкалендарь ForexFactory (бесплатный недельный JSON-фид).
// Используется как ФИЛЬТР: агент не входит ± newsBufferMin минут вокруг
// high-impact событий по USD/EUR. Триггером новости не являются.

import { request } from 'undici';
import { errMsg, log } from '../logger';

export interface NewsEvent {
  title: string;
  country: string;
  impact: string;
  date: Date;
}

const FEED_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const TTL_MS = 6 * 3600_000;

let cache: { at: number; events: NewsEvent[] } = { at: 0, events: [] };
let degraded = false;
let lastAttemptAt = 0;
let failStreak = 0;

// ForexFactory режет по IP (на Render общие адреса → HTTP 429 обычное дело),
// поэтому после неудачи не долбим фид каждым тиком планировщика (30 с),
// а ждём 1 → 2 → 4 → 8 мин…, максимум 15 мин.
const RETRY_MAX_MS = 15 * 60_000;

function retryDelayMs(): number {
  return Math.min(RETRY_MAX_MS, 60_000 * 2 ** Math.max(0, failStreak - 1));
}

export async function refreshCalendar(force = false): Promise<void> {
  const now = Date.now();
  if (!force && now - cache.at < TTL_MS) return;
  if (!force && failStreak > 0 && now - lastAttemptAt < retryDelayMs()) return;
  lastAttemptAt = now;
  try {
    const res = await request(FEED_URL, { headersTimeout: 10_000, bodyTimeout: 15_000 });
    const text = await res.body.text();
    if (res.statusCode >= 300) throw new Error(`HTTP ${res.statusCode}`);
    const raw = JSON.parse(text) as Array<Record<string, unknown>>;
    const events = raw
      .filter(e => e.impact === 'High' && (e.country === 'USD' || e.country === 'EUR'))
      .map(e => ({
        title: String(e.title ?? ''),
        country: String(e.country ?? ''),
        impact: String(e.impact ?? ''),
        date: new Date(String(e.date ?? '')),
      }))
      .filter(e => !Number.isNaN(e.date.getTime()));
    cache = { at: Date.now(), events };
    degraded = false;
    failStreak = 0;
    log.info(`календарь обновлён: ${events.length} high-impact событий USD/EUR на этой неделе`, undefined, 'news');
  } catch (e) {
    failStreak++;
    degraded = true;
    const waitMin = Math.max(1, Math.round(retryDelayMs() / 60_000));
    log.warn(`календарь новостей недоступен: ${errMsg(e)} (фильтр деградирует до «выключен»; следующая попытка через ~${waitMin} мин)`, undefined, 'news');
  }
}

export function newsStatus(): { events: number; updatedAt: Date | null; degraded: boolean } {
  return { events: cache.events.length, updatedAt: cache.at ? new Date(cache.at) : null, degraded };
}

export function isNewsBlackout(ts: Date, bufferMin: number): boolean {
  if (!bufferMin || !cache.events.length) return false;
  const t = ts.getTime();
  const buf = bufferMin * 60_000;
  return cache.events.some(e => Math.abs(e.date.getTime() - t) <= buf);
}

/** Минут до ближайшего события (для «памяти» сделки). null — календарь пуст. */
export function newsDistanceMin(ts: Date): number | null {
  if (!cache.events.length) return null;
  let best = Infinity;
  for (const e of cache.events) {
    const d = Math.abs(e.date.getTime() - ts.getTime()) / 60_000;
    if (d < best) best = d;
  }
  return Math.round(best);
}

export function upcomingNews(hoursAhead = 24): NewsEvent[] {
  const now = Date.now();
  return cache.events
    .filter(e => e.date.getTime() > now && e.date.getTime() < now + hoursAhead * 3600_000)
    .sort((a, b) => a.date.getTime() - b.date.getTime());
}
