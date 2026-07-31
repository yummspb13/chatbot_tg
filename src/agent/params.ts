// Параметры стратегии и риска. Хранятся в AgentSettings.params (JSON),
// правятся из Telegram (/agent_params set ...) и PWA — но только в пределах HARD_LIMITS.

export interface AgentParams {
  windowSec: number;       // окно momentum, сек
  thresholdPips: number;   // порог движения для входа, pips
  tpPips: number;          // take profit, pips
  slPips: number;          // stop loss, pips
  cooldownSec: number;     // пауза после сигнала, сек
  units: number;           // размер позиции, юниты базовой валюты (1000 = 0.01 лота)
  maxConcurrent: number;   // одновременных позиций
  maxTradesPerDay: number; // сделок в сутки (UTC)
  maxDailyLossUsd: number; // дневной лимит убытка → kill-switch
  spreadGuardPips: number; // не входить при спреде шире
  newsBufferMin: number;   // блокировка входа ± минут вокруг важных новостей
  autoBlackoutHours: number[]; // часы UTC, отключённые модулем обучения
}

export const DEFAULT_PARAMS: AgentParams = {
  windowSec: 300,
  thresholdPips: 5,
  tpPips: 12,
  slPips: 12,
  cooldownSec: 300,
  units: 1000,
  maxConcurrent: 1,
  maxTradesPerDay: 20,
  maxDailyLossUsd: 5,
  spreadGuardPips: 1.5,
  newsBufferMin: 15,
  autoBlackoutHours: [],
};

// Жёсткие потолки: настройки могут быть только строже. Мартингейла и наращивания лота нет.
export const HARD_LIMITS = {
  maxUnits: 2000,
  maxConcurrent: 3,
  maxTradesPerDay: 40,
  maxDailyLossUsd: 20,
};

function clampNum(v: unknown, min: number, max: number, def: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : def;
  return Math.min(Math.max(n, min), max);
}

export function clampParams(input: unknown): AgentParams {
  const p = (input && typeof input === 'object' ? input : {}) as Partial<AgentParams>;
  const hours = Array.isArray(p.autoBlackoutHours)
    ? p.autoBlackoutHours.filter(h => Number.isInteger(h) && h >= 0 && h < 24).slice(0, 8)
    : [];
  return {
    windowSec: Math.round(clampNum(p.windowSec, 10, 3600, DEFAULT_PARAMS.windowSec)),
    thresholdPips: clampNum(p.thresholdPips, 0.5, 100, DEFAULT_PARAMS.thresholdPips),
    tpPips: clampNum(p.tpPips, 2, 200, DEFAULT_PARAMS.tpPips),
    slPips: clampNum(p.slPips, 2, 200, DEFAULT_PARAMS.slPips),
    cooldownSec: Math.round(clampNum(p.cooldownSec, 5, 86400, DEFAULT_PARAMS.cooldownSec)),
    units: Math.round(clampNum(p.units, 1, HARD_LIMITS.maxUnits, DEFAULT_PARAMS.units)),
    maxConcurrent: Math.round(clampNum(p.maxConcurrent, 1, HARD_LIMITS.maxConcurrent, DEFAULT_PARAMS.maxConcurrent)),
    maxTradesPerDay: Math.round(clampNum(p.maxTradesPerDay, 1, HARD_LIMITS.maxTradesPerDay, DEFAULT_PARAMS.maxTradesPerDay)),
    maxDailyLossUsd: clampNum(p.maxDailyLossUsd, 0.5, HARD_LIMITS.maxDailyLossUsd, DEFAULT_PARAMS.maxDailyLossUsd),
    spreadGuardPips: clampNum(p.spreadGuardPips, 0.2, 10, DEFAULT_PARAMS.spreadGuardPips),
    newsBufferMin: Math.round(clampNum(p.newsBufferMin, 0, 120, DEFAULT_PARAMS.newsBufferMin)),
    autoBlackoutHours: hours,
  };
}

// Ключи, которые разрешено менять через /agent_params set и PWA
export const EDITABLE_KEYS: (keyof AgentParams)[] = [
  'windowSec', 'thresholdPips', 'tpPips', 'slPips', 'cooldownSec', 'units',
  'maxConcurrent', 'maxTradesPerDay', 'maxDailyLossUsd', 'spreadGuardPips', 'newsBufferMin',
];
