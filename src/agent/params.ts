// Параметры стратегии и риска. Хранятся в AgentSettings.params (JSON),
// правятся из Telegram (/agent_params set ...) и PWA — но только в пределах HARD_LIMITS.

export type StrategyType = 'momentum' | 'meanrev' | 'impulse' | 'echo' | 'straddle' | 'spreadweather';
// ladder — лимитная «лестница»: сигнал разбивается на 3 ступени (цена, −шаг, −2·шаг)
// с ОБЩИМИ TP/SL от якорной цены; суммарный объём = units, риск не превышает
// одиночного входа (это НЕ мартингейл: объём зафиксирован до входа).
// Шаг лестницы задаётся entryOffsetPips. Живой движок пока исполняет ladder как
// одиночную лимитку (честное подмножество); полная лестница — в бэктесте.
export type EntryMode = 'market' | 'limit' | 'ladder';

export interface AgentParams {
  // momentum — следование за движением; meanrev — возврат к среднему;
  // impulse — «асимметрия импульсов» (авторская: вход в сторону, куда цена ходит
  //           длинными ногами, против стороны коротких вымученных ног);
  // echo    — «эхо часа» (авторская: возврат к медианному внутридневному
  //           расписанию пары за последние 20 дней; для сигналов нужно ≥5 дней прогрева)
  // straddle — «микро-маркетмейкер» (авторская): БЕЗ прогноза, обе лимитки сразу
  //           (buy ниже, sell выше) в тихом рынке; порог = МАКСИМУМ диапазона окна,
  //           при котором ещё можно ставить (тренд убивает страддл)
  // spreadweather — «погода ликвидности» (авторская): сигнал не из цены, а из
  //           ПОВЕДЕНИЯ СПРЕДА — расширение спреда = страх маркетмейкеров; когда
  //           спред сжимается обратно, а цена осталась далеко от уровня до испуга,
  //           ставим на возврат. Требует реального спреда (loadM1WithSpread / live)
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
  entryOffsetPips: number; // отступ лимитной цены от пассивной стороны (0 = ровно bid/ladder-шаг)
  // Варианты выхода (пока учитываются ТОЛЬКО в бэктесте; в live — после победы в walk-forward):
  maxHoldSec: number;      // тайм-стоп: закрыть по рынку через N сек, если ни TP, ни SL (0 = выкл)
  beLockFrac: number;      // брейк-ивен-лок: пройдено frac пути к TP → SL переносится на вход (0 = выкл)
  partialFrac: number;     // частичная фиксация: половина объёма выходит на frac пути к TP (0 = выкл)
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
  maxHoldSec: 0,
  beLockFrac: 0,
  partialFrac: 0,
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

const STRATEGY_TYPES: StrategyType[] = ['momentum', 'meanrev', 'impulse', 'echo', 'straddle', 'spreadweather'];

export function clampParams(input: unknown): AgentParams {
  const p = (input && typeof input === 'object' ? input : {}) as Partial<AgentParams>;
  const strategyType: StrategyType = STRATEGY_TYPES.includes(p.strategyType as StrategyType)
    ? (p.strategyType as StrategyType)
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
    entryMode: p.entryMode === 'limit' || p.entryMode === 'ladder' ? p.entryMode : 'market',
    entryTtlSec: Math.round(clampNum(p.entryTtlSec, 10, 3600, DEFAULT_PARAMS.entryTtlSec)),
    entryOffsetPips: clampNum(p.entryOffsetPips, -2, 50, DEFAULT_PARAMS.entryOffsetPips), // ladder: это шаг ступени (крипте нужно ×4)
    maxHoldSec: Math.round(clampNum(p.maxHoldSec, 0, 604800, DEFAULT_PARAMS.maxHoldSec)),
    beLockFrac: clampNum(p.beLockFrac, 0, 0.9, DEFAULT_PARAMS.beLockFrac),
    partialFrac: clampNum(p.partialFrac, 0, 0.75, DEFAULT_PARAMS.partialFrac),
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
  strategyType: ['momentum', 'meanrev', 'impulse', 'echo', 'straddle', 'spreadweather'],
  entryMode: ['market', 'limit', 'ladder'],
};

// Ключи-списки часов UTC (задаются как "0,1,2,3" или "-" для пусто)
export const HOURLIST_KEYS = ['tradeHoursUtc'] as const;

// ------------------------------------------------------------------
// Крипто-эксперимент выходных (CRYPTO_WEEKEND=1): пока FX закрыт
// (пт 20:45 → вс 21:15 UTC), торгуется крипто-CFD на том же MT5-счёте.
//
// ЧЕСТНАЯ РАМКА (docs/CRYPTO-SWEEP-2026-07-31.md): подтверждённого
// walk-forward-преимущества у крипто-ячеек НЕТ (у BTC echo train
// отрицательный, у ETH momentum ожидание на грани шума). Это не торговая
// система, а сбор форвард-данных на демо минимальным объёмом.
// Параметры пресетов зафиксированы = лучшие ячейки sweep; на лету не меняются.

// ------------------------------------------------------------------
// Ансамбль (ENSEMBLE, включён по умолчанию): все стратегии крутятся
// ПАРАЛЛЕЛЬНО на живых котировках EUR/USD как ВИРТУАЛЬНЫЕ трейдеры —
// сделки пишутся в БД (mode=virtual, symbol=EUR_USD~<key>), денег не касаются.
// «Лицензия» пока справочная: 14 дней, ≥10 сделок, net > 0.
// Участник meanrev дублирует параметры живого контура — разница его
// виртуальных и реальных результатов = чистый замер качества исполнения.

export interface EnsembleMember {
  key: string;
  params: AgentParams;
}

export const ENSEMBLE_MEMBERS: EnsembleMember[] = [
  { key: 'meanrev', params: { ...DEFAULT_PARAMS } },
  {
    key: 'spreadw', // лучшая ячейка длинного прогона (docs/IDEAS-2026-07-31.md)
    params: { ...DEFAULT_PARAMS, strategyType: 'spreadweather', windowSec: 7200, thresholdPips: 4, tpPips: 10, slPips: 24, cooldownSec: 900 },
  },
  {
    key: 'momentum',
    params: { ...DEFAULT_PARAMS, strategyType: 'momentum', windowSec: 300, thresholdPips: 8, tpPips: 20, slPips: 20, cooldownSec: 300 },
  },
  {
    key: 'echo',
    params: { ...DEFAULT_PARAMS, strategyType: 'echo', windowSec: 3600, thresholdPips: 15, tpPips: 12, slPips: 20, cooldownSec: 1800 },
  },
  {
    key: 'impulse',
    params: { ...DEFAULT_PARAMS, strategyType: 'impulse', windowSec: 1800, thresholdPips: 2, tpPips: 10, slPips: 20, cooldownSec: 900 },
  },
];

// Крипто-ансамбль: те же роли на BTC-стриме крипто-ноги (24/7, включая выходные).
// Пороги ×4 (крипто-sweep), пипс при units=1000 стоит те же $0.10 — сравнимо с FX.
// echo-btc = копия live-пресета крипто-ноги: виртуальный vs реальный = замер
// исполнения на крипте; spreadweather на BTC впервые получает данные вообще
// (в бэктесте не хватило ask-истории).
export const ENSEMBLE_MEMBERS_BTC: EnsembleMember[] = [
  {
    key: 'btc-meanrev',
    params: { ...DEFAULT_PARAMS, windowSec: 1800, thresholdPips: 32, tpPips: 24, slPips: 80, spreadGuardPips: 5, maxDailyLossUsd: 20, newsBufferMin: 0 },
  },
  {
    key: 'btc-spreadw',
    params: { ...DEFAULT_PARAMS, strategyType: 'spreadweather', windowSec: 7200, thresholdPips: 16, tpPips: 40, slPips: 96, cooldownSec: 900, spreadGuardPips: 5, maxDailyLossUsd: 20, newsBufferMin: 0 },
  },
  {
    key: 'btc-echo',
    params: { ...DEFAULT_PARAMS, strategyType: 'echo', windowSec: 3600, thresholdPips: 40, tpPips: 48, slPips: 80, cooldownSec: 1800, spreadGuardPips: 5, maxDailyLossUsd: 20, newsBufferMin: 0 },
  },
  {
    key: 'btc-momentum',
    params: { ...DEFAULT_PARAMS, strategyType: 'momentum', windowSec: 300, thresholdPips: 32, tpPips: 80, slPips: 80, cooldownSec: 300, spreadGuardPips: 5, maxDailyLossUsd: 20, newsBufferMin: 0 },
  },
  {
    key: 'btc-impulse',
    params: { ...DEFAULT_PARAMS, strategyType: 'impulse', windowSec: 1800, thresholdPips: 8, tpPips: 40, slPips: 80, cooldownSec: 900, spreadGuardPips: 5, maxDailyLossUsd: 20, newsBufferMin: 0 },
  },
];

export interface CryptoPreset {
  key: 'btc' | 'eth';
  symbol: string;      // внутреннее имя в БД/отчётах
  mt5Symbol: string;   // имя символа у Exness Standard
  dukascopy: string;   // инструмент истории для прогрева echo
  priceScale: number;  // делитель цены: пип 0.0001 = $10 (BTC) / $1 (ETH)
  digits: number;      // знаков после запятой в реальной цене MT5
  params: AgentParams;
}

export const CRYPTO_PRESETS: Record<'btc' | 'eth', CryptoPreset> = {
  // echo/limit — лучшая выходная ячейка sweep (test +176$ в сб/вс, НО train-выходные −115$)
  btc: {
    key: 'btc',
    symbol: 'BTC_USD',
    mt5Symbol: 'BTCUSDm',
    dukascopy: 'btcusd',
    priceScale: 100_000, // 1000 юнитов = 0.01 лота (минимальный у Exness)
    digits: 2,
    params: {
      strategyType: 'echo',
      windowSec: 3600,
      thresholdPips: 40,
      tpPips: 48,
      slPips: 80,
      cooldownSec: 1800,
      units: 1000,
      maxConcurrent: 1,
      maxTradesPerDay: 20,
      maxDailyLossUsd: 20,
      spreadGuardPips: 5,
      newsBufferMin: 0, // FX-календарь к крипте не применяем (в выходные релизов нет)
      entryMode: 'limit',
      entryTtlSec: 180,
      entryOffsetPips: 0,
      maxHoldSec: 0,
      beLockFrac: 0,
      partialFrac: 0,
      tradeHoursUtc: [],
      autoBlackoutHours: [],
    },
  },
  // momentum/limit — единственная крипто-ячейка, зелёная и на train, и на test
  eth: {
    key: 'eth',
    symbol: 'ETH_USD',
    mt5Symbol: 'ETHUSDm',
    dukascopy: 'ethusd',
    priceScale: 10_000, // 1000 юнитов = 0.1 лота (0.1 ETH)
    digits: 2,
    params: {
      strategyType: 'momentum',
      windowSec: 300,
      thresholdPips: 12,
      tpPips: 30,
      slPips: 30,
      cooldownSec: 300,
      units: 1000,
      maxConcurrent: 1,
      maxTradesPerDay: 20,
      maxDailyLossUsd: 10,
      spreadGuardPips: 6,
      newsBufferMin: 0,
      entryMode: 'limit',
      entryTtlSec: 180,
      entryOffsetPips: 0,
      maxHoldSec: 0,
      beLockFrac: 0,
      partialFrac: 0,
      tradeHoursUtc: [],
      autoBlackoutHours: [],
    },
  },
};
