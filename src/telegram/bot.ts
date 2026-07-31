// Управление агентом из Telegram: только админ (TELEGRAM_ADMIN_CHAT_ID).
// Уведомления об открытии/закрытии сделок и ежечасные сводки шлются через notify().

import { Context, Telegraf } from 'telegraf';
import { config } from '../config';
import { errMsg, log } from '../logger';
import { AgentEngine, fmtUsd } from '../agent/engine';
import { EDITABLE_KEYS, AgentParams } from '../agent/params';
import { newsStatus, upcomingNews } from '../news/calendar';
import type { TradeStore } from '../store';

let bot: Telegraf | null = null;

export function tgEnabled(): boolean {
  return !!(config.telegramToken && config.adminChatId);
}

function getBot(): Telegraf {
  if (!config.telegramToken) throw new Error('TELEGRAM_BOT_TOKEN не задан');
  if (!bot) bot = new Telegraf(config.telegramToken);
  return bot;
}

export async function notify(text: string): Promise<void> {
  if (!tgEnabled()) return;
  try {
    await getBot().telegram.sendMessage(config.adminChatId!, text);
  } catch (e) {
    log.warn(`telegram notify: ${errMsg(e)}`, undefined, 'telegram');
  }
}

function isAdmin(ctx: Context): boolean {
  const admin = (config.adminChatId ?? '').trim();
  if (!admin) return false;
  const ids = [ctx.from?.id, ctx.chat?.id].filter(v => v !== undefined).map(String);
  return ids.includes(admin);
}

const HELP = [
  'FX-агент — команды:',
  '/agent_start — запустить',
  '/agent_stop — остановить (live-позиции остаются под SL/TP)',
  '/agent_status — состояние, счёт, котировка, новости',
  '/agent_report [today|week] — отчёт: PnL, сделки, издержки',
  '/agent_params — показать параметры',
  '/agent_params set <ключ> <значение> — изменить параметр',
  '/agent_mode <sim|live> — режим (live = OANDA, какой счёт — задаёт OANDA_ENV)',
  '/agent_kill — 🚨 закрыть все позиции и остановить',
  '/agent_test_order <buy|sell> — тестовый ордер (проверка связки)',
].join('\n');

export interface BotDeps {
  engine: AgentEngine;
  store: TradeStore;
  buildHourlyReport: (windowMin: number) => Promise<string>;
}

function fmtParams(p: AgentParams): string {
  return [
    `windowSec=${p.windowSec} thresholdPips=${p.thresholdPips}`,
    `tpPips=${p.tpPips} slPips=${p.slPips} cooldownSec=${p.cooldownSec}`,
    `units=${p.units} maxConcurrent=${p.maxConcurrent}`,
    `maxTradesPerDay=${p.maxTradesPerDay} maxDailyLossUsd=${p.maxDailyLossUsd}`,
    `spreadGuardPips=${p.spreadGuardPips} newsBufferMin=${p.newsBufferMin}`,
    `autoBlackoutHours=[${p.autoBlackoutHours.join(',')}] (управляется обучением)`,
  ].join('\n');
}

export async function startTelegram(deps: BotDeps): Promise<void> {
  if (!config.telegramToken) {
    log.warn('TELEGRAM_BOT_TOKEN не задан — Telegram-бот выключен', undefined, 'telegram');
    return;
  }
  if (!config.adminChatId) {
    log.warn('TELEGRAM_ADMIN_CHAT_ID не задан — Telegram-бот выключен', undefined, 'telegram');
    return;
  }
  const b = getBot();

  b.use(async (ctx, next) => {
    if (!isAdmin(ctx)) {
      if (ctx.message) await ctx.reply('Доступ запрещён.').catch(() => {});
      return;
    }
    return next();
  });

  b.command(['start', 'help'], ctx => ctx.reply(HELP));

  b.command('agent_start', async ctx => {
    try {
      await ctx.reply(await deps.engine.start());
    } catch (e) {
      await ctx.reply(`⚠️ ${errMsg(e)}`);
    }
  });

  b.command('agent_stop', async ctx => {
    try {
      await ctx.reply(await deps.engine.stop());
    } catch (e) {
      await ctx.reply(`⚠️ ${errMsg(e)}`);
    }
  });

  b.command('agent_kill', async ctx => {
    try {
      await deps.engine.kill('ручной /agent_kill из Telegram');
      // текст уведомления уже ушёл через notify()
    } catch (e) {
      await ctx.reply(`⚠️ ${errMsg(e)}`);
    }
  });

  b.command('agent_status', async ctx => {
    const s = deps.engine.status();
    const news = newsStatus();
    const next3 = upcomingNews(24).slice(0, 3);
    const lines: string[] = [];
    lines.push(`Агент: ${s.running ? '🟢 работает' : '⚪️ остановлен'}${s.killSwitchAt ? ` (kill-switch: ${s.killSwitchAt.toISOString()})` : ''}`);
    lines.push(`Режим: ${s.mode ?? '—'}${s.mode === 'live' ? ` → OANDA ${s.oandaEnv}` : ''} · Символ: ${s.symbol ?? '—'}`);
    if (s.lastQuote) {
      lines.push(`Котировка: ${s.lastQuote.bid.toFixed(5)}/${s.lastQuote.ask.toFixed(5)} (${s.lastQuoteAgoSec}с назад)`);
    }
    if (s.account) {
      lines.push(`Счёт: баланс ${s.account.balance.toFixed(2)} ${s.account.currency}, equity ${s.account.equity.toFixed(2)}, позиций ${s.account.openPositionCount}`);
    }
    lines.push(`Сегодня: ${fmtUsd(s.realizedToday)}, сделок ${s.tradesToday}`);
    if (s.fxWeekend) lines.push('⚠️ Выходные FX — входы заблокированы');
    if (s.lastError) lines.push(`Последняя ошибка: ${s.lastError}`);
    lines.push(`Новости: ${news.degraded ? '⚠️ фид недоступен' : `${news.events} high-impact на неделе`}`);
    for (const n of next3) lines.push(`  · ${n.date.toISOString().slice(5, 16).replace('T', ' ')} UTC ${n.country}: ${n.title}`);
    await ctx.reply(lines.join('\n'));
  });

  b.command('agent_report', async ctx => {
    const arg = (ctx.message.text.split(/\s+/)[1] ?? 'today').toLowerCase();
    const now = new Date();
    const since = arg === 'week'
      ? new Date(now.getTime() - 7 * 86400_000)
      : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const settings = await deps.store.getSettings();
    const trades = await deps.store.closedTradesSince(settings.mode, since);
    if (!trades.length) {
      await ctx.reply(`Отчёт (${arg}): закрытых сделок нет.`);
      return;
    }
    const pnl = trades.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const costs = trades.reduce((s, t) => s + (t.costSpread ?? 0) + (t.costCommission ?? 0), 0);
    const wins = trades.filter(t => (t.pnl ?? 0) > 0).length;
    const best = Math.max(...trades.map(t => t.pnl ?? 0));
    const worst = Math.min(...trades.map(t => t.pnl ?? 0));
    await ctx.reply([
      `Отчёт (${arg}, режим ${settings.mode}):`,
      `Сделок: ${trades.length}, прибыльных ${wins} (${Math.round((wins / trades.length) * 100)}%)`,
      `PnL: ${fmtUsd(pnl)} · Издержки (спред): ${costs.toFixed(2)}$`,
      `Лучшая: ${fmtUsd(best)} · Худшая: ${fmtUsd(worst)}`,
    ].join('\n'));
  });

  b.command('agent_params', async ctx => {
    const parts = ctx.message.text.trim().split(/\s+/);
    if (parts[1] === 'set' && parts.length >= 4) {
      const key = parts[2] as keyof AgentParams;
      if (!EDITABLE_KEYS.includes(key)) {
        await ctx.reply(`⚠️ Ключ «${parts[2]}» нельзя менять. Доступны: ${EDITABLE_KEYS.join(', ')}`);
        return;
      }
      const value = Number(parts[3]);
      if (!Number.isFinite(value)) {
        await ctx.reply('⚠️ Значение должно быть числом');
        return;
      }
      const params = await deps.engine.applyParams({ [key]: value } as Partial<AgentParams>);
      await ctx.reply(`✅ Обновлено (в пределах жёстких лимитов):\n${fmtParams(params)}`);
      return;
    }
    const settings = await deps.store.getSettings();
    await ctx.reply(`Параметры:\n${fmtParams(settings.params)}\n\nИзменить: /agent_params set <ключ> <значение>`);
  });

  b.command('agent_mode', async ctx => {
    const arg = (ctx.message.text.split(/\s+/)[1] ?? '').toLowerCase();
    if (arg !== 'sim' && arg !== 'live') {
      await ctx.reply('Использование: /agent_mode sim | live');
      return;
    }
    try {
      await ctx.reply(await deps.engine.setMode(arg));
    } catch (e) {
      await ctx.reply(`⚠️ ${errMsg(e)}`);
    }
  });

  b.command('agent_test_order', async ctx => {
    const arg = (ctx.message.text.split(/\s+/)[1] ?? '').toLowerCase();
    if (arg !== 'buy' && arg !== 'sell') {
      await ctx.reply('Использование: /agent_test_order buy | sell');
      return;
    }
    try {
      await ctx.reply(await deps.engine.testOrder(arg === 'buy' ? 'BUY' : 'SELL'));
    } catch (e) {
      await ctx.reply(`⚠️ ${errMsg(e)}`);
    }
  });

  b.command('agent_report_hour', async ctx => {
    await ctx.reply(await deps.buildHourlyReport(config.reportWindowMin));
  });

  b.catch((err, ctx) => {
    log.error(`telegraf: ${errMsg(err)} (update ${ctx.updateType})`, undefined, 'telegram');
  });

  // launch() в telegraf резолвится только при остановке — не await'им
  void b.launch({ dropPendingUpdates: true }).catch(e => {
    const msg = errMsg(e);
    if (msg.includes('409')) {
      log.error(
        'Telegram 409: этот токен уже опрашивает другой процесс (старый afisha-деплой?). '
        + 'Отключите старый webhook/деплой или выпустите новый токен у BotFather.',
        undefined, 'telegram',
      );
    } else {
      log.error(`telegram launch: ${msg}`, undefined, 'telegram');
    }
  });

  try {
    const me = await b.telegram.getMe();
    log.success(`Telegram-бот запущен: @${me.username}`, undefined, 'telegram');
  } catch (e) {
    log.warn(`telegram getMe: ${errMsg(e)}`, undefined, 'telegram');
  }
}

export async function stopTelegram(): Promise<void> {
  if (bot) {
    try {
      bot.stop('SIGTERM');
    } catch {
      // уже остановлен
    }
  }
}
