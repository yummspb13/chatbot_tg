// Бэктест: ТОТ ЖЕ код стратегий и риск-модуля, что торгует вживую,
// прогоняется по M1-истории с моделью издержек (спред + расширение на ролловере)
// и моделью лимитных входов (entryMode=limit: вход по своей цене без спреда,
// но сигнал может не исполниться — честно моделируем и это).
// Оговорки: новостной фильтр в бэктесте не применяется (нет бесплатного
// исторического календаря); прошлое не гарантирует будущее.
//
// CLI:
//   npm run backtest -- --from 2024-01-01 --to 2026-07-30                 # дефолт, EUR/USD
//   npm run backtest -- --pair gbpusd --optimize                          # другая пара
//   npm run backtest -- --params '{"strategyType":"meanrev","entryMode":"limit"}'

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PIP } from '../broker/types';
import { AgentParams, clampParams, DEFAULT_PARAMS, EntryMode } from '../agent/params';
import { buildStrategy } from '../agent/strategy';
import { RiskManager } from '../agent/risk';
import { Candle, loadM1 } from './data';

export interface MarketSpec {
  instrument: string;      // имя у Dukascopy (eurusd)
  symbol: string;          // имя у OANDA (EUR_USD)
  spreadBase: number;      // типичный спред, pips
  spreadRollover: number;  // 21–22 UTC
  spreadSundayOpen: number;
  crypto?: boolean;        // 24/7 (включая выходные), без FX-ролловера
  priceScale?: number;     // делитель сырой цены: пип 0.0001 остаётся базовой единицей
  pipsMult?: number;       // множитель пип-значений грида (волатильность выше FX)
  paramsBase?: Partial<AgentParams>; // базовые параметры для всех ячеек грида рынка
  beSlipPips?: number;     // проскальзывание стопа-в-безубытке (BE-лок), pips — пессимизм модели
}

// Крипто-CFD (Exness BTCUSDm/ETHUSDm) торгуются 24/7. Цена делится на priceScale:
// «пип» BTC = $10, ETH = $1 — при units=1000 стоимость пипса у ВСЕХ рынков
// одинаковая ($0.10), а 1000 юнитов BTC = 0.01 лота (минимальный у Exness).
// Спреды взяты по Exness Standard (заметно шире Dukascopy-фида — честнее);
// pipsMult откалиброван по медианному часовому ходу (июнь–июль 2026:
// BTC 13.2 пипса, ETH 4.5, EUR/USD 3.7).
export const MARKETS: Record<string, MarketSpec> = {
  eurusd: { instrument: 'eurusd', symbol: 'EUR_USD', spreadBase: 1.0, spreadRollover: 2.5, spreadSundayOpen: 2.0, beSlipPips: 0.3 },
  gbpusd: { instrument: 'gbpusd', symbol: 'GBP_USD', spreadBase: 1.3, spreadRollover: 3.0, spreadSundayOpen: 2.5, beSlipPips: 0.4 },
  audusd: { instrument: 'audusd', symbol: 'AUD_USD', spreadBase: 1.2, spreadRollover: 2.8, spreadSundayOpen: 2.2, beSlipPips: 0.4 },
  nzdusd: { instrument: 'nzdusd', symbol: 'NZD_USD', spreadBase: 1.8, spreadRollover: 3.5, spreadSundayOpen: 2.8, beSlipPips: 0.5 },
  // Расширение портфеля 01.08.2026 (калибровка по июню-июлю 2026, спреды Exness
  // Standard): JPY-пары через priceScale 100 (пип 0.01), золото/индекс через
  // 10000 (пип $1), нефть через 100 (пип 1 цент). pipsMult — по медианному
  // часовому ходу против EUR/USD (3.7п): jpy 3.2→1, gbpjpy 7.4→2, gold 6.3→2,
  // sp500 6.3→2, oil 25→6.
  usdjpy: {
    instrument: 'usdjpy', symbol: 'USD_JPY',
    spreadBase: 1.6, spreadRollover: 3.5, spreadSundayOpen: 2.5,
    priceScale: 100, pipsMult: 1, beSlipPips: 0.4,
    paramsBase: { spreadGuardPips: 3, maxDailyLossUsd: 5 },
  },
  gbpjpy: {
    instrument: 'gbpjpy', symbol: 'GBP_JPY',
    spreadBase: 3.0, spreadRollover: 5.0, spreadSundayOpen: 4.0,
    priceScale: 100, pipsMult: 2, beSlipPips: 0.6,
    paramsBase: { spreadGuardPips: 6, maxDailyLossUsd: 10 },
  },
  xauusd: {
    instrument: 'xauusd', symbol: 'XAU_USD',
    spreadBase: 0.4, spreadRollover: 0.9, spreadSundayOpen: 0.7,
    priceScale: 10_000, pipsMult: 2, beSlipPips: 0.5,
    paramsBase: { spreadGuardPips: 1.5, maxDailyLossUsd: 10 },
  },
  usa500idxusd: {
    instrument: 'usa500idxusd', symbol: 'SPX500_USD',
    spreadBase: 0.7, spreadRollover: 1.5, spreadSundayOpen: 1.0,
    priceScale: 10_000, pipsMult: 2, beSlipPips: 0.5,
    paramsBase: { spreadGuardPips: 2, maxDailyLossUsd: 10 },
  },
  lightcmdusd: {
    instrument: 'lightcmdusd', symbol: 'WTICO_USD',
    spreadBase: 3.5, spreadRollover: 6.0, spreadSundayOpen: 5.0,
    priceScale: 100, pipsMult: 6, beSlipPips: 1,
    paramsBase: { spreadGuardPips: 8, maxDailyLossUsd: 20 },
  },
  btcusd: {
    instrument: 'btcusd', symbol: 'BTC_USD',
    spreadBase: 2.5, spreadRollover: 2.5, spreadSundayOpen: 2.5,
    crypto: true, priceScale: 100_000, pipsMult: 4,
    paramsBase: { spreadGuardPips: 5, maxDailyLossUsd: 20 },
    beSlipPips: 2, // $20/BTC — стоп в крипте скользит ощутимо
  },
  ethusd: {
    instrument: 'ethusd', symbol: 'ETH_USD',
    spreadBase: 3.0, spreadRollover: 3.0, spreadSundayOpen: 3.0,
    crypto: true, priceScale: 10_000, pipsMult: 1.5,
    paramsBase: { spreadGuardPips: 6, maxDailyLossUsd: 10 },
    beSlipPips: 3,
  },
  // Волна калибровки 03.08.2026 (docs/CALIBRATION-2026-08-03.md, живые спреды
  // Exness с нашего счёта): шестёрка на свип — два лучших индекса в истории
  // проекта (Nikkei ratio 0.018, DAX 0.024), два JPY-кросса, комодо-кросс и
  // сюрприз калибровки USDZAR. Спреды заложены ×1.5 от снятого снапшота —
  // консервативный запас на расширение в нерабочие часы.
  jp225: {
    instrument: 'jpnidxjpy', symbol: 'JP225_JPY',
    spreadBase: 1.0, spreadRollover: 2.0, spreadSundayOpen: 1.5,
    priceScale: 100_000, pipsMult: 10, beSlipPips: 0.5, // пип = 10 пунктов индекса
    paramsBase: { spreadGuardPips: 3, maxDailyLossUsd: 15 },
  },
  de30: {
    instrument: 'deuidxeur', symbol: 'DE30_EUR',
    spreadBase: 0.25, spreadRollover: 0.6, spreadSundayOpen: 0.4,
    priceScale: 100_000, pipsMult: 2, beSlipPips: 0.3, // пип = 10 пунктов индекса
    paramsBase: { spreadGuardPips: 1, maxDailyLossUsd: 10 },
  },
  audjpy: {
    instrument: 'audjpy', symbol: 'AUD_JPY',
    spreadBase: 1.7, spreadRollover: 3.5, spreadSundayOpen: 2.5,
    priceScale: 100, pipsMult: 3, beSlipPips: 0.5,
    paramsBase: { spreadGuardPips: 4, maxDailyLossUsd: 10 },
  },
  eurjpy: {
    instrument: 'eurjpy', symbol: 'EUR_JPY',
    spreadBase: 2.4, spreadRollover: 4.5, spreadSundayOpen: 3.5,
    priceScale: 100, pipsMult: 4, beSlipPips: 0.5,
    paramsBase: { spreadGuardPips: 5, maxDailyLossUsd: 10 },
  },
  gbpnzd: {
    instrument: 'gbpnzd', symbol: 'GBP_NZD',
    spreadBase: 3.6, spreadRollover: 7.0, spreadSundayOpen: 5.5,
    priceScale: 1, pipsMult: 6, beSlipPips: 0.8,
    paramsBase: { spreadGuardPips: 8, maxDailyLossUsd: 15 },
  },
  usdzar: {
    instrument: 'usdzar', symbol: 'USD_ZAR',
    priceScale: 10, pipsMult: 7, beSlipPips: 1, // пип = 0.001 ранда
    spreadBase: 6.0, spreadRollover: 12.0, spreadSundayOpen: 9.0,
    paramsBase: { spreadGuardPips: 12, maxDailyLossUsd: 15 },
  },
};

/** Приведение сырых цен рынка к масштабу, где пип 0.0001 осмыслен (крипта). */
export function prepCandles(candles: Candle[], market: MarketSpec): Candle[] {
  const s = market.priceScale ?? 1;
  if (s === 1) return candles;
  return candles.map(c => ({
    t: c.t, o: c.o / s, h: c.h / s, l: c.l / s, c: c.c / s,
    ...(c.sp !== undefined ? { sp: c.sp / s } : {}),
  }));
}

export interface BtTrade {
  side: 'BUY' | 'SELL';
  entry: number;
  exit: number;
  pnl: number;
  spreadCost: number;
  openedAt: number;
  closedAt: number;
  reason: string;
  hourUtc: number;
  maePips?: number; // худший плавающий минус позиции (max adverse excursion), pips
}

export interface BtReport {
  market: string;
  from: string;
  to: string;
  params: AgentParams;
  candles: number;
  signals: number;
  unfilledEntries: number; // лимитные входы, которые не исполнились
  trades: number;
  wins: number;
  winRate: number;
  netUsd: number;
  spreadCostUsd: number;
  grossUsd: number;
  expectancyUsd: number;
  maxDrawdownUsd: number;
  profitFactor: number;
  tradesPerWeek: number;
  killDays: number;
  byHour: { hour: number; n: number; netUsd: number }[];
  byDow: { dow: number; n: number; netUsd: number }[]; // день недели UTC (0=вс, 6=сб)
  tradeList?: BtTrade[]; // полный список сделок (только по запросу keepTrades — для оверлеев)
}

function spreadPipsAt(t: Date, m: MarketSpec): number {
  if (m.crypto) return m.spreadBase; // круглосуточный рынок, ролловера нет
  const h = t.getUTCHours();
  const day = t.getUTCDay();
  if (h === 21 || h === 22) return m.spreadRollover;
  if (day === 0) return m.spreadSundayOpen;
  return m.spreadBase;
}

interface OpenPos {
  side: 'BUY' | 'SELL';
  entry: number;
  tp: number;
  sl: number;
  units: number;
  openedAt: number;
  spreadCost: number;
  beLocked?: boolean; // брейк-ивен-лок уже сработал
  maePips?: number;   // худший плавающий минус за жизнь позиции
}

/** Открытие позиции с учётом partialFrac: одна цель или две (ближняя + полная). */
function splitPosition(
  side: 'BUY' | 'SELL', entry: number, tpPips: number, slPips: number,
  units: number, openedAt: number, spreadCost: number, partialFrac: number,
): OpenPos[] {
  const dir = side === 'BUY' ? 1 : -1;
  const sl = entry - dir * slPips * PIP;
  if (partialFrac > 0) {
    const uNear = Math.max(1, Math.round(units / 2));
    const uFar = Math.max(1, units - uNear);
    return [
      { side, entry, tp: entry + dir * tpPips * partialFrac * PIP, sl, units: uNear, openedAt, spreadCost: spreadCost / 2 },
      { side, entry, tp: entry + dir * tpPips * PIP, sl, units: uFar, openedAt, spreadCost: spreadCost / 2 },
    ];
  }
  return [{ side, entry, tp: entry + dir * tpPips * PIP, sl, units, openedAt, spreadCost }];
}

interface PendingBt {
  side: 'BUY' | 'SELL';
  price: number;
  tpPips: number;
  slPips: number;
  placedAt: number;
  units?: number;    // лестница: объём ступени (иначе params.units)
  tpPrice?: number;  // лестница: ОБЩИЙ TP от якоря (абсолютная цена)
  slPrice?: number;  // лестница: ОБЩИЙ SL от якоря
}

export function runBacktest(
  candles: Candle[],
  paramsIn: Partial<AgentParams>,
  market: MarketSpec = MARKETS.eurusd,
  opts?: { keepTrades?: boolean; rawParams?: boolean },
): BtReport {
  // rawParams — ТОЛЬКО для исследований (напр., тест «без стопов» с SL за
  // пределами боевых клампов); боевые контуры всегда идут через clampParams
  const params = opts?.rawParams
    ? { ...DEFAULT_PARAMS, ...paramsIn } as AgentParams
    : clampParams({ ...DEFAULT_PARAMS, ...paramsIn });
  const strategy = buildStrategy(params);
  const risk = new RiskManager(params);

  const trades: BtTrade[] = [];
  let open: OpenPos[] = [];
  let pending: PendingBt[] = [];
  let dayKey = '';
  let tradesToday = 0;
  let realizedToday = 0;
  let killedToday = false;
  let killDays = 0;
  let signals = 0;
  let unfilledEntries = 0;

  const closePos = (p: OpenPos, exit: number, at: number, reason: string) => {
    const pnl = (p.side === 'BUY' ? exit - p.entry : p.entry - exit) * p.units;
    realizedToday += pnl;
    trades.push({
      side: p.side, entry: p.entry, exit, pnl, spreadCost: p.spreadCost,
      openedAt: p.openedAt, closedAt: at, reason, hourUtc: new Date(p.openedAt).getUTCHours(),
      maePips: p.maePips !== undefined ? +p.maePips.toFixed(1) : undefined,
    });
  };

  for (const c of candles) {
    const time = new Date(c.t);
    // реальный исторический спред минуты (loadM1WithSpread) — или модельный
    const spreadPips = c.sp !== undefined ? c.sp / PIP : spreadPipsAt(time, market);
    const half = (spreadPips * PIP) / 2;

    const key = time.toISOString().slice(0, 10);
    if (key !== dayKey) {
      dayKey = key;
      tradesToday = 0;
      realizedToday = 0;
      killedToday = false;
    }

    // исполнение отложенных лимитных входов (вход без издержки спреда)
    if (pending.length) {
      const still: PendingBt[] = [];
      for (const p of pending) {
        if (c.t - p.placedAt > params.entryTtlSec * 1000) {
          unfilledEntries += 1;
          continue;
        }
        const fills = p.side === 'BUY' ? (c.l - half) <= p.price : (c.h + half) >= p.price;
        if (fills) {
          if (p.tpPrice !== undefined || p.slPrice !== undefined) {
            // лестница: абсолютные общие уровни, без частичной фиксации
            open.push({
              side: p.side,
              entry: p.price,
              tp: p.tpPrice ?? (p.side === 'BUY' ? p.price + p.tpPips * PIP : p.price - p.tpPips * PIP),
              sl: p.slPrice ?? (p.side === 'BUY' ? p.price - p.slPips * PIP : p.price + p.slPips * PIP),
              units: p.units ?? params.units,
              openedAt: c.t,
              spreadCost: 0,
            });
          } else {
            open.push(...splitPosition(p.side, p.price, p.tpPips, p.slPips, p.units ?? params.units, c.t, 0, params.partialFrac));
          }
          tradesToday += 1;
        } else {
          still.push(p);
        }
      }
      pending = still;
    }

    // TP/SL внутри свечи (кроме открытых этой же свечой); оба задеты → пессимистично SL.
    // Затем варианты выхода: тайм-стоп (по рынку) и брейк-ивен-лок (срабатывает
    // со СЛЕДУЮЩЕЙ свечи — консервативно занижает пользу лока, не завышает).
    const still: OpenPos[] = [];
    for (const p of open) {
      // худший плавающий минус позиции (для честности вариантов «без стопа»)
      const adverse = p.side === 'BUY' ? (p.entry - (c.l - half)) / PIP : ((c.h + half) - p.entry) / PIP;
      if (adverse > (p.maePips ?? 0)) p.maePips = adverse;
      if (p.openedAt === c.t) { still.push(p); continue; }
      let exit: number | null = null;
      let reason = '';
      if (p.side === 'BUY') {
        const bidLow = c.l - half;
        const bidHigh = c.h - half;
        if (bidLow <= p.sl) { exit = p.sl; reason = 'SL'; }
        else if (bidHigh >= p.tp) { exit = p.tp; reason = 'TP'; }
      } else {
        const askHigh = c.h + half;
        const askLow = c.l + half;
        if (askHigh >= p.sl) { exit = p.sl; reason = 'SL'; }
        else if (askLow <= p.tp) { exit = p.tp; reason = 'TP'; }
      }
      if (exit === null && params.maxHoldSec > 0 && c.t - p.openedAt >= params.maxHoldSec * 1000) {
        exit = p.side === 'BUY' ? c.c - half : c.c + half;
        reason = 'TIME';
      }
      if (exit !== null) {
        // стоп-в-безубытке — это стоп: в реальности он проскальзывает; модель
        // без этой поправки завышает пользу BE-лока на порядок частых $0-выходов
        if (p.beLocked && reason === 'SL' && exit === p.entry) {
          const slip = (market.beSlipPips ?? 0) * PIP;
          exit = p.side === 'BUY' ? exit - slip : exit + slip;
          reason = 'BE';
        }
        closePos(p, exit, c.t, reason);
        continue;
      }
      if (params.beLockFrac > 0 && !p.beLocked) {
        const dir = p.side === 'BUY' ? 1 : -1;
        const trigger = p.entry + dir * (p.tp - p.entry) * params.beLockFrac;
        const reached = p.side === 'BUY' ? (c.h - half) >= trigger : (c.l + half) <= trigger;
        if (reached) {
          p.sl = p.entry; // дальше хуже безубытка не будет
          p.beLocked = true;
        }
      }
      still.push(p);
    }
    open = still;

    if (!killedToday && realizedToday <= -params.maxDailyLossUsd) {
      for (const p of open) {
        const exit = p.side === 'BUY' ? c.c - half : c.c + half;
        closePos(p, exit, c.t, 'KILL');
      }
      open = [];
      pending = [];
      killedToday = true;
      killDays += 1;
    }

    const bid = c.c - half;
    const ask = c.c + half;
    const sig = strategy.onQuote({ symbol: market.symbol, bid, ask, time });
    if (!sig || killedToday) continue;
    signals += 1;

    const verdict = risk.check({
      now: time,
      openCount: open.length + pending.length,
      tradesToday,
      plToday: realizedToday,
      spreadPips,
      newsBlackout: false,
      crypto: !!market.crypto,
    });
    if (!verdict.ok) continue;

    if (sig.both) {
      // страддл: обе лимитки сразу (в market-режиме смысла нет — пропуск)
      if (params.entryMode === 'market') continue;
      pending.push(
        { side: 'BUY', price: bid, tpPips: sig.tpPips, slPips: sig.slPips, placedAt: c.t },
        { side: 'SELL', price: ask, tpPips: sig.tpPips, slPips: sig.slPips, placedAt: c.t },
      );
    } else if (params.entryMode === 'ladder') {
      // лестница: 3 ступени вглубь от пассивной стороны, ОБЩИЕ TP/SL от якоря;
      // суммарный объём = units (это не мартингейл — риск зафиксирован до входа)
      const stepPips = Math.max(1, params.entryOffsetPips || 3);
      const anchor = sig.side === 'BUY' ? bid : ask;
      const rungUnits = Math.max(1, Math.round(params.units / 3));
      const tpPrice = sig.side === 'BUY' ? anchor + sig.tpPips * PIP : anchor - sig.tpPips * PIP;
      const slPrice = sig.side === 'BUY' ? anchor - sig.slPips * PIP : anchor + sig.slPips * PIP;
      for (let i = 0; i < 3; i++) {
        const price = sig.side === 'BUY' ? anchor - i * stepPips * PIP : anchor + i * stepPips * PIP;
        pending.push({
          side: sig.side, price, tpPips: sig.tpPips, slPips: sig.slPips,
          placedAt: c.t, units: rungUnits, tpPrice, slPrice,
        });
      }
    } else if (params.entryMode === 'limit') {
      const price = sig.side === 'BUY' ? bid - params.entryOffsetPips * PIP : ask + params.entryOffsetPips * PIP;
      pending.push({ side: sig.side, price, tpPips: sig.tpPips, slPips: sig.slPips, placedAt: c.t });
    } else {
      const entry = sig.side === 'BUY' ? ask : bid;
      open.push(...splitPosition(sig.side, entry, sig.tpPips, sig.slPips, params.units, c.t, spreadPips * PIP * params.units, params.partialFrac));
      tradesToday += 1;
    }
  }

  if (candles.length) {
    const last = candles[candles.length - 1];
    const half = (spreadPipsAt(new Date(last.t), market) * PIP) / 2;
    for (const p of open) {
      closePos(p, p.side === 'BUY' ? last.c - half : last.c + half, last.t, 'EOD');
    }
    open = [];
    unfilledEntries += pending.length;
    pending = [];
  }

  const netUsd = trades.reduce((s, t) => s + t.pnl, 0);
  const spreadCostUsd = trades.reduce((s, t) => s + t.spreadCost, 0);
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl < 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));

  let peak = 0, dd = 0, cum = 0;
  for (const t of trades) {
    cum += t.pnl;
    if (cum > peak) peak = cum;
    if (peak - cum > dd) dd = peak - cum;
  }

  const byHourMap = new Map<number, { n: number; netUsd: number }>();
  const byDowMap = new Map<number, { n: number; netUsd: number }>();
  for (const t of trades) {
    const b = byHourMap.get(t.hourUtc) ?? { n: 0, netUsd: 0 };
    b.n += 1;
    b.netUsd += t.pnl;
    byHourMap.set(t.hourUtc, b);
    const dow = new Date(t.openedAt).getUTCDay();
    const d = byDowMap.get(dow) ?? { n: 0, netUsd: 0 };
    d.n += 1;
    d.netUsd += t.pnl;
    byDowMap.set(dow, d);
  }

  const weeks = candles.length ? (candles[candles.length - 1].t - candles[0].t) / (7 * 86400_000) : 1;

  return {
    market: market.instrument,
    from: candles.length ? new Date(candles[0].t).toISOString().slice(0, 10) : '',
    to: candles.length ? new Date(candles[candles.length - 1].t).toISOString().slice(0, 10) : '',
    params,
    candles: candles.length,
    signals,
    unfilledEntries,
    trades: trades.length,
    wins: wins.length,
    winRate: trades.length ? wins.length / trades.length : 0,
    netUsd,
    spreadCostUsd,
    grossUsd: netUsd + spreadCostUsd,
    expectancyUsd: trades.length ? netUsd / trades.length : 0,
    maxDrawdownUsd: dd,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
    tradesPerWeek: trades.length / Math.max(weeks, 0.1),
    killDays,
    byHour: [...byHourMap.entries()].map(([hour, b]) => ({ hour, ...b })).sort((a, b) => a.hour - b.hour),
    byDow: [...byDowMap.entries()].map(([dow, b]) => ({ dow, ...b })).sort((a, b) => a.dow - b.dow),
    ...(opts?.keepTrades ? { tradeList: trades } : {}),
  };
}

export interface OptimizeResult {
  best: { params: Partial<AgentParams>; train: BtReport; test: BtReport } | null;
  table: { params: Partial<AgentParams>; trainNet: number; trainTrades: number; testNet?: number }[];
  split: number;
}

export function gridFor(
  strategyType: AgentParams['strategyType'],
  entryMode: EntryMode,
  units: number,
  pipsMult = 1, // растяжка пип-порогов под волатильность рынка (крипта: BTC ×4, ETH ×1.5)
  base: Partial<AgentParams> = {},
): Partial<AgentParams>[] {
  const m = (v: number) => v * pipsMult;
  const grid: Partial<AgentParams>[] = [];
  if (strategyType === 'momentum') {
    for (const windowSec of [300, 900]) {
      for (const thresholdPips of [5, 8]) {
        for (const tp of [12, 20]) {
          grid.push({ ...base, strategyType, entryMode, windowSec, thresholdPips: m(thresholdPips), tpPips: m(tp), slPips: m(tp), cooldownSec: windowSec, units });
        }
      }
    }
  } else if (strategyType === 'meanrev') {
    for (const windowSec of [1800, 3600]) {
      for (const thresholdPips of [8, 12]) {
        for (const tpPips of [6, 10]) {
          grid.push({ ...base, strategyType, entryMode, windowSec, thresholdPips: m(thresholdPips), tpPips: m(tpPips), slPips: m(20), cooldownSec: 900, units });
        }
      }
    }
  } else if (strategyType === 'impulse') {
    // авторская «асимметрия импульсов»: порог = разница средних ног (pips)
    for (const windowSec of [1800, 3600]) {
      for (const thresholdPips of [1, 2]) {
        for (const tpPips of [6, 10]) {
          grid.push({ ...base, strategyType, entryMode, windowSec, thresholdPips: m(thresholdPips), tpPips: m(tpPips), slPips: m(20), cooldownSec: 900, units });
        }
      }
    }
  } else if (strategyType === 'straddle') {
    // авторский «микро-маркетмейкер»: порог = МАКСИМУМ диапазона окна (тихий рынок);
    // обе лимитки занимают 2 слота → maxConcurrent 2; в market-режиме не существует
    if (entryMode === 'market') return [];
    for (const windowSec of [600, 1200]) {
      for (const thresholdPips of [6, 12]) {
        for (const tpPips of [3, 6]) {
          grid.push({ ...base, strategyType, entryMode, windowSec, thresholdPips: m(thresholdPips), tpPips: m(tpPips), slPips: m(20), cooldownSec: 120, units, maxConcurrent: 2 });
        }
      }
    }
  } else if (strategyType === 'spreadweather') {
    // авторская «погода ликвидности»: порог = мин. сдвиг цены от якоря до-испуга
    for (const windowSec of [7200, 14400]) {
      for (const thresholdPips of [6, 12]) {
        for (const tpPips of [10, 16]) {
          grid.push({ ...base, strategyType, entryMode, windowSec, thresholdPips: m(thresholdPips), tpPips: m(tpPips), slPips: m(24), cooldownSec: 900, units });
        }
      }
    }
  } else if (strategyType === 'vprofile') {
    // учебниковый «профиль сессии»: порог = зона касания уровня (pips)
    for (const thresholdPips of [3, 6]) {
      for (const tpPips of [15, 25]) {
        for (const slPips of [15, 25]) {
          grid.push({ ...base, strategyType, entryMode, windowSec: 7200, thresholdPips: m(thresholdPips), tpPips: m(tpPips), slPips: m(slPips), cooldownSec: 1800, units });
        }
      }
    }
  } else if (strategyType === 'matrend') {
    // учебниковая «тренд + откат к EMA»: порог = мин. глубина отката (pips)
    for (const windowSec of [7200, 14400]) {
      for (const thresholdPips of [3, 6]) {
        for (const tpPips of [15, 25]) {
          grid.push({ ...base, strategyType, entryMode, windowSec, thresholdPips: m(thresholdPips), tpPips: m(tpPips), slPips: m(20), cooldownSec: 1800, units });
        }
      }
    }
  } else {
    // авторская «эхо часа»: порог = отклонение от внутридневного расписания (pips)
    for (const thresholdPips of [10, 15, 20]) {
      for (const tpPips of [8, 12]) {
        grid.push({ ...base, strategyType, entryMode, windowSec: 3600, thresholdPips: m(thresholdPips), tpPips: m(tpPips), slPips: m(20), cooldownSec: 1800, units });
      }
    }
  }
  if (entryMode === 'ladder') {
    // лестница поверх сигнальной стратегии: шаг ступени (pips) через entryOffsetPips,
    // 3 ступени занимают 3 слота → maxConcurrent 3 (жёсткий потолок как раз 3)
    return grid.flatMap(g => [3, 5].map(step => ({ ...g, entryOffsetPips: m(step), maxConcurrent: 3 })));
  }
  return grid;
}

/** Walk-forward: подбор на train-периоде, честная проверка top-3 на test-периоде. */
export function optimize(
  candles: Candle[],
  grid: Partial<AgentParams>[],
  market: MarketSpec = MARKETS.eurusd,
  split = 0.7,
): OptimizeResult {
  const cut = Math.floor(candles.length * split);
  const train = candles.slice(0, cut);
  const test = candles.slice(cut);

  const table: OptimizeResult['table'] = [];
  const ranked: { params: Partial<AgentParams>; train: BtReport }[] = [];
  for (const g of grid) {
    const r = runBacktest(train, g, market);
    table.push({ params: g, trainNet: r.netUsd, trainTrades: r.trades });
    if (r.trades >= 30) ranked.push({ params: g, train: r });
  }
  ranked.sort((a, b) => b.train.netUsd - a.train.netUsd);

  let best: OptimizeResult['best'] = null;
  for (const cand of ranked.slice(0, 3)) {
    const t = runBacktest(test, cand.params, market);
    const row = table.find(x => x.params === cand.params);
    if (row) row.testNet = t.netUsd;
    if (!best || t.netUsd > best.test.netUsd) best = { params: cand.params, train: cand.train, test: t };
  }
  return { best, table, split };
}

export function formatReport(r: BtReport, title: string): string {
  const p = r.params;
  const lines = [
    `— ${title} —`,
    `Рынок: ${r.market} · период ${r.from} → ${r.to} (${r.candles} минуток)`,
    `Параметры: ${p.strategyType}/${p.entryMode} window=${p.windowSec}s порог=${p.thresholdPips}p TP/SL=${p.tpPips}/${p.slPips}p units=${p.units}`,
    `Сделок: ${r.trades} (~${r.tradesPerWeek.toFixed(1)}/нед), win-rate ${(r.winRate * 100).toFixed(1)}%`,
    `Net: ${r.netUsd.toFixed(2)}$ · издержки спреда: ${r.spreadCostUsd.toFixed(2)}$ · gross: ${r.grossUsd.toFixed(2)}$`,
    `Ожидание: ${r.expectancyUsd >= 0 ? '+' : ''}${r.expectancyUsd.toFixed(3)}$/сделку · макс. просадка: ${r.maxDrawdownUsd.toFixed(2)}$ · PF: ${Number.isFinite(r.profitFactor) ? r.profitFactor.toFixed(2) : '∞'}`,
    `Дней с kill-switch: ${r.killDays}`,
  ];
  if (p.entryMode === 'limit') {
    lines.push(`Лимитные входы: исполнено ${r.trades}, не исполнено ${r.unfilledEntries} (${r.signals} сигналов)`);
  }
  const wknd = r.byDow.filter(d => d.dow === 0 || d.dow === 6);
  const wkndN = wknd.reduce((s, d) => s + d.n, 0);
  if (wkndN > 0) {
    const wkndNet = wknd.reduce((s, d) => s + d.netUsd, 0);
    lines.push(`Выходные (сб+вс UTC): ${wkndN} сделок, net ${wkndNet >= 0 ? '+' : ''}${wkndNet.toFixed(2)}$`);
  }
  return lines.join('\n');
}

function parseArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  (async () => {
    const from = new Date(parseArg('from') ?? '2024-01-01');
    const to = new Date(parseArg('to') ?? new Date().toISOString().slice(0, 10));
    const pair = (parseArg('pair') ?? 'eurusd').toLowerCase();
    const market = MARKETS[pair];
    if (!market) {
      console.error(`Неизвестная пара «${pair}». Доступны: ${Object.keys(MARKETS).join(', ')}`);
      process.exit(1);
    }
    const extra = { ...market.paramsBase, ...(parseArg('params') ? JSON.parse(parseArg('params')!) : {}) };
    const doOptimize = process.argv.includes('--optimize');
    const candles = prepCandles(await loadM1(market.instrument, from, to), market);
    if (candles.length < 1000) {
      console.error('Слишком мало данных');
      process.exit(1);
    }

    const out: Record<string, unknown> = {};
    const base = runBacktest(candles, extra, market);
    console.log(formatReport(base, 'Заданные параметры, весь период'));
    out.base = base;

    if (doOptimize) {
      console.log('\nWalk-forward подбор (train 70% / test 30%)…');
      const params = clampParams({ ...DEFAULT_PARAMS, ...extra });
      const grid = gridFor(params.strategyType, params.entryMode, params.units, market.pipsMult ?? 1, market.paramsBase);
      const opt = optimize(candles, grid, market);
      out.optimize = opt;
      if (opt.best) {
        console.log(formatReport(opt.best.train, `Лучшие на train: ${JSON.stringify(opt.best.params)}`));
        console.log(formatReport(opt.best.test, 'Те же параметры на test (honest)'));
      } else {
        console.log('Ни одна комбинация не дала ≥30 сделок на train.');
      }
    }

    mkdirSync(path.join(process.cwd(), 'data'), { recursive: true });
    const file = path.join(process.cwd(), 'data', 'backtest-report.json');
    writeFileSync(file, JSON.stringify(out, null, 2));
    console.log(`\nОтчёт сохранён: ${file}`);
  })().catch(e => {
    console.error(e);
    process.exit(1);
  });
}
