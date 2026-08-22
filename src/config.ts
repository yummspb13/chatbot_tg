import 'dotenv/config';
import { randomBytes } from 'node:crypto';

function num(v: string | undefined, def: number): number {
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : def;
}

export const config = {
  port: num(process.env.PORT, 3000),
  databaseUrl: process.env.DATABASE_URL || null,

  telegramToken: process.env.TELEGRAM_BOT_TOKEN || null,
  adminChatId: process.env.TELEGRAM_ADMIN_CHAT_ID || null,

  adminPassword: process.env.ADMIN_PASSWORD || null,
  sessionSecret: process.env.SESSION_SECRET || randomBytes(32).toString('hex'),
  sessionSecretGenerated: !process.env.SESSION_SECRET,

  vapidPublicKey: process.env.VAPID_PUBLIC_KEY || null,
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY || null,

  // live-брокер: oanda (REST) или metaapi (MT5 через MetaApi.cloud — Exness и т.п.)
  broker: (process.env.BROKER === 'metaapi' ? 'metaapi' : 'oanda') as 'oanda' | 'metaapi',

  oandaEnv: (process.env.OANDA_ENV === 'live' ? 'live' : 'practice') as 'practice' | 'live',
  oandaToken: process.env.OANDA_API_TOKEN || null,
  oandaAccountId: process.env.OANDA_ACCOUNT_ID || null,

  metaapiToken: process.env.METAAPI_TOKEN || null,
  metaapiAccountId: process.env.METAAPI_ACCOUNT_ID || null,
  mt5Symbol: process.env.MT5_SYMBOL || 'EURUSD', // у Exness Standard — EURUSDm

  // Крипто-эксперимент выходных: пока FX закрыт, торгуем крипто-CFD на том же
  // MT5-счёте (только live+metaapi). Честная рамка — см. CRYPTO_PRESETS в params.ts.
  cryptoWeekend: process.env.CRYPTO_WEEKEND === '1',
  // 21.08: владелец явно расширил крипто-входы на всю неделю («он хорош как для
  // выходных, так и для не выходных»). CRYPTO_ALLWEEK=0 вернёт только-выходные.
  cryptoAllWeek: process.env.CRYPTO_ALLWEEK !== '0',
  cryptoPreset: (process.env.CRYPTO_PRESET === 'eth' ? 'eth' : 'btc') as 'btc' | 'eth',
  mt5SymbolCrypto: process.env.MT5_SYMBOL_CRYPTO || null, // дефолт берётся из пресета

  // Мейкер-эксперимент на Binance Futures TESTNET (фейковые деньги, реальный стакан):
  // post-only страддл — там, где пассивной стороне не нужен спред, а комиссия известна.
  // ЖАНР ЗАКРЫТ 03.08.2026 по команде владельца (вердикт по заранее зафиксированному
  // правилу: 323 круга, −45.39$, ни одного плюсового дня — docs/MAKER-CLOSURE-2026-08-03.md).
  // MAKER_TESTNET больше не читается; ключи оставлены для подчистки хвостов на старте.
  makerTestnet: false as boolean,
  binanceTestnetKey: process.env.BINANCE_TESTNET_KEY || null,
  binanceTestnetSecret: process.env.BINANCE_TESTNET_SECRET || null,
  binanceSymbol: process.env.BINANCE_SYMBOL || 'BTCUSDT',
  // размер цикла и дневной лимит мейкера (деньги фейковые; комиссия ПРОЦЕНТНАЯ —
  // размер меняет читаемость цифр, но не знак ожидания)
  makerQtyBtc: num(process.env.MAKER_QTY_BTC, 0.01),
  makerDailyLossUsd: num(process.env.MAKER_DAILY_LOSS_USD, 50),

  // Ансамбль виртуальных стратегий на живых котировках (mode=virtual в БД).
  // Включён по умолчанию в live-режиме; ENSEMBLE=0 — выключить.
  ensemble: process.env.ENSEMBLE !== '0',

  // Мультирыночная виртуальная нога: золото/нефть/GBPJPY/S&P500 (победители
  // свипа 01.08) на том же MT5-счёте. Требует ансамбль; MARKETS=0 — выключить.
  markets: process.env.MARKETS !== '0',

  // РФ-ветка: виртуальная MOEX-нога на маркетдате T-Invest API.
  tinkoffToken: process.env.TINKOFF_TOKEN || null,

  // Micro-этап AFKS (решение владельца 18.08: депозит 20 000 ₽, старый токен
  // осознанно оставлен до рубежа 100к): зеркало лицензированного виртуала
  // afks-matrend реальными лимитками. Режимы: off | sandbox (дефолт — песочница
  // Тинькофф, фейковые деньги) | live (ТОЛЬКО явный AFKS_LIVE=1 от владельца).
  afksLive: (process.env.AFKS_LIVE === '1' ? 'live'
    : process.env.AFKS_LIVE === '0' ? 'off' : 'sandbox') as 'off' | 'sandbox' | 'live',
  afksLots: num(process.env.AFKS_LOTS, 5),                    // лотов на сделку (AFKS лот = 100 акций)
  // Мультитикер-зеркала: 'ТИКЕР:виртуал:лоты,...'. Правило дома — подключение
  // при лицензии виртуала; SIBN добавлен на 7/10 живых сделках ЯВНЫМ решением
  // владельца 21.08 («всё ок, одобряю — говорю явно»).
  // 22.08: AFKS срезан до 2 лотов по постмортему (режим-пила, ожидание 14д < 0);
  // возврат к 5 — решением владельца после возврата тренда и exp14 > 0
  mirrors: (process.env.MIRRORS || 'AFKS:afks-matrend:2,SIBN:sibn-meanrev:5')
    .split(',')
    .map(s => {
      const [ticker, memberKey, lots] = s.trim().split(':');
      return { ticker: (ticker || '').toUpperCase(), memberKey: memberKey || '', lots: Number(lots) || 5 };
    })
    .filter(m => m.ticker && m.memberKey),
  afksFeeFrac: num(process.env.AFKS_FEE_FRAC, 0.0005),        // комиссия за СТОРОНУ (тариф «Трейдер» 0.05%)
  afksDailyLossRub: num(process.env.AFKS_DAILY_LOSS_RUB, 500), // дневной стоп зеркала, ₽
  afksAccountId: process.env.AFKS_ACCOUNT_ID || null,          // боевой счёт; пусто — первый открытый

  // Polymarket-подсистема (docs/POLYMARKET-PLAN-2026-08-17.md): read-only
  // коллектор 5-минуток + бумажный мейкер. POLY=0 — общий kill-switch.
  poly: process.env.POLY !== '0',

  // Новостной фон, контур Б (решение владельца 22.08): RSS → LLM-прогнозы
  // направления форвардом, судья 12/24/96ч. Read-only, к торговле не подключён
  // до гейта (≥30 прогнозов, точность 12-24ч бьёт монетку). NEWS_BIAS=0 — выкл.
  newsBias: process.env.NEWS_BIAS !== '0',
  polyAssets: (process.env.POLY_ASSETS || 'btc,eth').split(',').map(s => s.trim()).filter(Boolean),

  agentModeDefault: (process.env.AGENT_MODE === 'live' ? 'live' : 'sim') as 'sim' | 'live',
  symbolDefault: process.env.SYMBOL || 'EUR_USD',
  simStartBalance: num(process.env.SIM_START_BALANCE, 50),

  reportWindowMin: Math.min(Math.max(num(process.env.REPORT_WINDOW_MIN, 60), 15), 120),

  autoRetrain: process.env.AUTO_RETRAIN === '1',
  openaiKey: process.env.OPENAI_API_KEY || null,
  openaiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
};

export type AppConfig = typeof config;
