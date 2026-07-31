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
  cryptoPreset: (process.env.CRYPTO_PRESET === 'eth' ? 'eth' : 'btc') as 'btc' | 'eth',
  mt5SymbolCrypto: process.env.MT5_SYMBOL_CRYPTO || null, // дефолт берётся из пресета

  // Мейкер-эксперимент на Binance Futures TESTNET (фейковые деньги, реальный стакан):
  // post-only страддл — там, где пассивной стороне не нужен спред, а комиссия известна
  makerTestnet: process.env.MAKER_TESTNET === '1',
  binanceTestnetKey: process.env.BINANCE_TESTNET_KEY || null,
  binanceTestnetSecret: process.env.BINANCE_TESTNET_SECRET || null,
  binanceSymbol: process.env.BINANCE_SYMBOL || 'BTCUSDT',

  // Ансамбль виртуальных стратегий на живых котировках (mode=virtual в БД).
  // Включён по умолчанию в live-режиме; ENSEMBLE=0 — выключить.
  ensemble: process.env.ENSEMBLE !== '0',

  agentModeDefault: (process.env.AGENT_MODE === 'live' ? 'live' : 'sim') as 'sim' | 'live',
  symbolDefault: process.env.SYMBOL || 'EUR_USD',
  simStartBalance: num(process.env.SIM_START_BALANCE, 50),

  reportWindowMin: Math.min(Math.max(num(process.env.REPORT_WINDOW_MIN, 60), 15), 120),

  autoRetrain: process.env.AUTO_RETRAIN === '1',
  openaiKey: process.env.OPENAI_API_KEY || null,
  openaiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
};

export type AppConfig = typeof config;
