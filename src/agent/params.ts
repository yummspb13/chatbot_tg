// Параметры стратегии и риска. Хранятся в AgentSettings.params (JSON),
// правятся из Telegram (/agent_params set ...) и PWA — но только в пределах HARD_LIMITS.

export type StrategyType = 'momentum' | 'meanrev' | 'impulse' | 'echo';
export type EntryMode = 'market' | 'limit';

export interface AgentParams {
  // momentum — следование за движением; meanrev — возврат к среднему;
  // impulse — «асимметрия импульсов» (авторская: вход в сторону, куда цена ходит
  //           длинными ногами, против стороны коротких вымученных ног);
  // echo    — «эхо часа» (авторская: возврат к медианному внутридневному
  //           расписанию пары за последние 20 дней; для сигналов нужно ≥5 дней прогрева)
  strategyType: StrategyType;
  windowSec: number;       // окно стратегии, сек (momentum: окно движения; meanrev: окно среднего)
  thresholdPips: number;   // momentum: порог движения; meanrev: порог отклонения от среднего
  tpPips: number;          // take profit, pips
  slPips: number;          // stop loss, pips
  cooldownSec: number;     // пауза после сигнала, сек
  units: number;           // размер позиции, юниты базовой валюты (1000 = 0.01 лота)
  maxConcurrent: number;   // одновременных позиций (включая отложенные входы)
  maxTradesPerDay: number; // сделок в сутки (UTC)
  maxDailyLossUsd: number; // дневной лимит убытка → kill-switch
  spreadGuardPips: number; // не входить при спреде шире
  newsBufferMin: number;   // блокировка входа ± минут вокруг важных новостей
  entryMode: EntryMode;    // market — платим спред; limit — пассивный вход без спреда (риск неисполнения)
  entryTtlSec: number;     // сколько живёт лимитный вход до отмены
  entryOffsetPips: number; // отступ лимитной цены от пассивной стороны (0 = ровно bid/ask)
  tradeHoursUtc: number[]; // разрешённые часы UTC для входов (пусто = все)
  autoBlackoutHours: number[]; // часы UTC, отключённые модулем обучения
}

// Дефолт = лучшая ячейка sweep 31.07.2026 (EUR/USD meanrev/limit:
// единственная комбинация, положительная и на train (+8$), и на test (+60$/9 мес);
// см. docs/SWEEP-2026-07-31.md — с оговорками о модели лимитных филлов).
export const DEFAULT_PARAMS: AgentParams = {
  strategyType: 'meanrev',
  windowSec: 3600,
  thresholdPips: 12,
  tpPips: 10,
  slPips: 20,
  cooldownSec: 900,
  units: 1000,
  maxConcurrent: 1,
  maxTradesPerDay: 20,
  maxDailyLossUsd: 5,
  spreadGuardPips: 1.5,
  newsBufferMin: 15,
  entryMode: 'limit',
  entryTtlSec: 180,
  entryOffsetPips: 0,
  tradeHoursUtc: [],
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

function hourList(v: unknown, maxLen: number): number[] {
  return Array.isArray(v)
    ? v.filter(h => Number.isInteger(h) && h >= 0 && h < 24).slice(0, maxLen)
    : [];
}

export function clampParams(input: unknown): AgentParams {
  const p = (input && typeof input === 'object' ? input : {}) as Partial<AgentParams>;
  const strategyType: StrategyType =
    p.strategyType === 'meanrev' || p.strategyType === 'impulse' || p.strategyType === 'echo'
      ? p.strategyType
      : 'momentum';
  return {
    strategyType,
    windowSec: Math.round(clampNum(p.windowSec, 10, 14400, DEFAULT_PARAMS.windowSec)),
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
    entryMode: p.entryMode === 'limit' ? 'limit' : 'market',
    entryTtlSec: Math.round(clampNum(p.entryTtlSec, 10, 3600, DEFAULT_PARAMS.entryTtlSec)),
    entryOffsetPips: clampNum(p.entryOffsetPips, -2, 5, DEFAULT_PARAMS.entryOffsetPips),
    tradeHoursUtc: hourList(p.tradeHoursUtc, 24),
    autoBlackoutHours: hourList(p.autoBlackoutHours, 8),
  };
}

// Числовые ключи, которые разрешено менять через /agent_params set и PWA
export const EDITABLE_KEYS: (keyof AgentParams)[] = [
  'windowSec', 'thresholdPips', 'tpPips', 'slPips', 'cooldownSec', 'units',
  'maxConcurrent', 'maxTradesPerDay', 'maxDailyLossUsd', 'spreadGuardPips', 'newsBufferMin',
  'entryTtlSec', 'entryOffsetPips',
];

// Строковые ключи с перечислимыми значениями
export const ENUM_KEYS: Record<string, string[]> = {
  strategyType: ['momentum', 'meanrev', 'impulse', 'echo'],
  entryMode: ['market', 'limit'],
};

// Ключи-списки часов UTC (задаются как "0,1,2,3" или "-" для пусто)
export const HOURLIST_KEYS = ['tradeHoursUtc'] as const;
