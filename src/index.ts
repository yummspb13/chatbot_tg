// Точка входа: конфиг → store → движок → Telegram → PWA/HTTP → планировщики.

import { config } from './config';
import { errMsg, log } from './logger';
import { disconnectDb } from './db';
import { createStore } from './store';
import { AgentEngine, fmtUsd } from './agent/engine';
import { isNewsBlackout, newsDistanceMin, refreshCalendar } from './news/calendar';
import { notify as tgNotify, startTelegram, stopTelegram } from './telegram/bot';
import { initPush, sendPushToAll } from './web/push';
import { startWebServer } from './web/server';
import { runNightlyLearning } from './learn/stats';
import { runWeeklyRetrain } from './learn/proposals';
import { runDailyLlmReview } from './learn/llm-review';

const store = createStore();

async function notifyAll(text: string): Promise<void> {
  await tgNotify(text);
  // важные алерты дублируем в Web Push (PWA)
  if (text.startsWith('🚨')) {
    await sendPushToAll(store, 'FX Agent — алерт', text.slice(0, 180)).catch(() => {});
  }
}

const engine = new AgentEngine({
  store,
  notify: notifyAll,
  isNewsBlackout,
  newsDistanceMin,
});

async function buildHourlyReport(windowMin: number): Promise<string> {
  const settings = await store.getSettings();
  const r = await store.windowReport(settings.mode, windowMin);
  const st = engine.status();
  const lines = [
    `⏱ Сводка за ${r.windowMin} мин (режим ${settings.mode}):`,
    `Доход/расход: ${fmtUsd(r.pnl)} по ${r.closedCount} закрытым (прибыльных ${r.wins})`,
    `Новых входов: ${r.openedCount}, издержки входов (спред): ${r.costs.toFixed(2)}$`,
    `Открыто сейчас: ${r.openNow}`,
  ];
  if (st.account) {
    lines.push(`Счёт: баланс ${st.account.balance.toFixed(2)}, equity ${st.account.equity.toFixed(2)} ${st.account.currency}`);
  }
  lines.push(`С начала дня: ${fmtUsd(st.realizedToday)}, сделок ${st.tradesToday}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------- планировщики

let lastHourlyKey = '';
let lastNightlyKey = '';
let lastWeeklyKey = '';
let lastLlmKey = '';

function schedulerTick(): void {
  const now = new Date();
  const hourKey = now.toISOString().slice(0, 13);
  const dayKey = now.toISOString().slice(0, 10);

  // ежечасная сводка (PWA push + Telegram) — только когда агент работает
  if (now.getUTCMinutes() === 0 && lastHourlyKey !== hourKey && engine.isRunning()) {
    lastHourlyKey = hourKey;
    void (async () => {
      const text = await buildHourlyReport(config.reportWindowMin);
      await tgNotify(text);
      await sendPushToAll(store, 'FX Agent — сводка за час', text);
    })().catch(e => log.warn(`hourly report: ${errMsg(e)}`, undefined, 'scheduler'));
  }

  // ночное обучение 00:10 UTC
  if (now.getUTCHours() === 0 && now.getUTCMinutes() >= 10 && lastNightlyKey !== dayKey) {
    lastNightlyKey = dayKey;
    void runNightlyLearning(store, engine, notifyAll);
  }

  // еженедельный ребэктест: воскресенье 12:00 UTC (рынок закрыт)
  if (now.getUTCDay() === 0 && now.getUTCHours() === 12 && lastWeeklyKey !== dayKey) {
    lastWeeklyKey = dayKey;
    void runWeeklyRetrain(store, notifyAll);
  }

  // LLM-дневник 06:00 UTC
  if (now.getUTCHours() === 6 && now.getUTCMinutes() < 2 && lastLlmKey !== dayKey) {
    lastLlmKey = dayKey;
    void runDailyLlmReview(store, notifyAll);
  }

  // календарь новостей (внутри — TTL 6ч)
  void refreshCalendar().catch(() => {});
}

// ---------------------------------------------------------------- запуск

async function main(): Promise<void> {
  log.info(`fx-agent стартует: PORT=${config.port}, режим по умолчанию ${config.agentModeDefault}, OANDA_ENV=${config.oandaEnv}`, undefined, 'boot');
  if (config.sessionSecretGenerated && config.adminPassword) {
    log.warn('SESSION_SECRET не задан — сгенерирован на время процесса (логины PWA слетят при рестарте)', undefined, 'boot');
  }

  initPush();
  await refreshCalendar(true);

  const server = startWebServer({ engine, store, buildHourlyReport });
  await startTelegram({ engine, store, buildHourlyReport });

  setInterval(schedulerTick, 30_000);

  // авто-возобновление после деплоя/рестарта
  try {
    const settings = await store.getSettings();
    if (settings.isRunning) {
      log.info('isRunning=true в настройках — возобновляю агента', undefined, 'boot');
      const msg = await engine.start();
      await notifyAll(`🔄 Рестарт сервиса. ${msg}`);
    }
  } catch (e) {
    log.error(`авто-возобновление не удалось: ${errMsg(e)}`, undefined, 'boot');
    await notifyAll(`⚠️ Рестарт сервиса: авто-возобновление не удалось — ${errMsg(e)}`);
  }

  let shuttingDown = false;
  const shutdown = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`получен ${sig}, останавливаюсь…`, undefined, 'boot');
    const force = setTimeout(() => process.exit(0), 8000);
    try {
      await engine.suspend();
      await stopTelegram();
      server.close();
      await disconnectDb();
    } finally {
      clearTimeout(force);
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch(e => {
  log.error(`fatal: ${errMsg(e)}`, e, 'boot');
  process.exit(1);
});
