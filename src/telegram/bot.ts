// Управление агентом из Telegram: только админ (TELEGRAM_ADMIN_CHAT_ID).
// Уведомления об открытии/закрытии сделок и ежечасные сводки шлются через notify().

import { Context, Telegraf } from 'telegraf';
import { config } from '../config';
import { errMsg, log } from '../logger';
import { AgentEngine, fmtUsd } from '../agent/engine';
import { AgentParams, EDITABLE_KEYS, ENUM_KEYS, HOURLIST_KEYS } from '../agent/params';
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
    `strategyType=${p.strategyType} entryMode=${p.entryMode}`,
    `windowSec=${p.windowSec} thresholdPips=${p.thresholdPips}`,
    `tpPips=${p.tpPips} slPips=${p.slPips} cooldownSec=${p.cooldownSec}`,
    `units=${p.units} maxConcurrent=${p.maxConcurrent}`,
    `maxTradesPerDay=${p.maxTradesPerDay} maxDailyLossUsd=${p.maxDailyLossUsd}`,
    `spreadGuardPips=${p.spreadGuardPips} newsBufferMin=${p.newsBufferMin}`,
    `entryTtlSec=${p.entryTtlSec} entryOffsetPips=${p.entryOffsetPips}`,
    `tradeHoursUtc=[${p.tradeHoursUtc.join(',')}] (пусто = все часы)`,
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
    const c = s.crypto;
    if (c && 'running' in c && c.running && 'symbol' in c) {
      lines.push(
        `🧪 Крипто-нога: ${c.symbol} (${c.strategy}) — ${c.entriesActive ? 'входы АКТИВНЫ (FX закрыт)' : c.haltedToday ? 'пауза до завтра (дневной лимит)' : 'наблюдает (входы только в FX-выходные)'}`,
      );
      lines.push(`   за день ${fmtUsd(c.realizedToday)}, сделок ${c.tradesToday}, лимит −${c.maxDailyLossUsd}$${c.lastQuoteAgoSec !== null ? ` · котировка ${c.lastQuoteAgoSec}с назад` : ''}`);
    } else if (c && c.enabled && !c.running) {
      lines.push('🧪 Крипто-нога: включена, но не запущена (нужен live + metaapi)');
    }
    const m = s.maker;
    if (m && 'running' in m && m.running && 'symbol' in m) {
      lines.push(
        `⚗️ Мейкер-тестнет (${m.symbol}): ${m.haltedToday ? 'пауза до завтра (лимит дня)' : m.quiet ? 'тихо — котирует' : 'рынок бежит — ждёт'}`
        + `${m.inventoryBtc ? ` · инвентарь ${m.inventoryBtc} BTC (${m.unrealized >= 0 ? '+' : ''}${m.unrealized.toFixed(3)}$)` : ''}`,
      );
      lines.push(`   за день ${fmtUsd(m.realizedToday)}, кругов ${m.tradesToday}, лимит −${m.maxDailyLossUsd}$ (фейковые деньги)`);
    } else if (m && m.enabled && !m.running) {
      lines.push('⚗️ Мейкер-тестнет: включён, но не запущен (нужны BINANCE_TESTNET_KEY/SECRET)');
    }
    const mk = s.markets;
    if (mk && mk.running && 'markets' in mk) {
      lines.push(
        `🌍 Мультирынок (виртуально): ${mk.markets.join(', ')}`
        + (mk.lastQuoteAgoSec !== null ? ` · котировка ${mk.lastQuoteAgoSec}с назад` : ' · рынки закрыты — котировок нет'),
      );
    }
    const mx = s.moex;
    if (mx && mx.running && 'tickers' in mx) {
      lines.push(
        `🇷🇺 MOEX (виртуально): ${mx.tickers.join(', ')} — `
        + (mx.inSession ? `сессия идёт${mx.lastQuoteAgoSec !== null ? `, котировка ${mx.lastQuoteAgoSec}с назад` : ''}` : 'сессия закрыта'),
      );
    }
    lines.push(`Новости: ${news.degraded ? '⚠️ фид недоступен' : `${news.events} high-impact на неделе`}`);
    for (const n of next3) lines.push(`  · ${n.date.toISOString().slice(5, 16).replace('T', ' ')} UTC ${n.country}: ${n.title}`);
    await ctx.reply(lines.join('\n'));
  });

  // Telegram режет сообщения на 4096 символах: 48 участников одним куском не
  // влезают (команда молча падала) — шлём частями с запасом
  const replyChunked = async (ctx: { reply: (t: string) => Promise<unknown> }, lines: string[]): Promise<void> => {
    let buf: string[] = [];
    let len = 0;
    for (const line of lines) {
      if (len + line.length + 1 > 3500 && buf.length) {
        await ctx.reply(buf.join('\n'));
        buf = [];
        len = 0;
      }
      buf.push(line);
      len += line.length + 1;
    }
    if (buf.length) await ctx.reply(buf.join('\n'));
  };

  b.command('agent_ensemble', async ctx => {
    const st = await deps.engine.ensembleStats();
    if (!st) {
      await ctx.reply('🎼 Ансамбль не запущен (нужен live-режим и работающий агент; ENSEMBLE=0 его выключает).');
      return;
    }
    const lines = [`🎼 Ансамбль: ${st.members.length} виртуальных контуров (14 дней)${st.running ? '' : ' — ОСТАНОВЛЕН'}`];
    for (const g of st.groups) {
      lines.push('');
      lines.push(`── ${g.title} ──`);
      for (const m of g.members) {
        const lic = m.license === 'granted' ? '✅' : m.license === 'denied' ? '❌' : `⏳${m.trades14}/10`;
        lines.push(
          `${m.key} ${lic} · ${m.net14 >= 0 ? '+' : ''}${m.net14}$/${m.trades14}сд/wr${m.winRate14}%`
          + ` · дн ${m.realizedToday >= 0 ? '+' : ''}${m.realizedToday}$/${m.tradesToday}`
          + (m.openNow || m.pendingNow ? ` · откр${m.openNow}/лим${m.pendingNow}` : '')
          + (m.hotStreak && m.hotStreak > 0 ? ` ⚡${m.hotStreak}` : '')
          + (m.bf14 > 0 ? ` (BF${m.bf14})` : ''),
        );
      }
    }
    lines.push('');
    lines.push('Лицензии справочные (BF-догонки в них не входят): реальным объёмом ансамбль не управляет.');
    await replyChunked(ctx, lines);
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
      const key = parts[2];
      const raw = parts[3];
      let patch: Partial<AgentParams> | null = null;

      if (ENUM_KEYS[key]) {
        if (!ENUM_KEYS[key].includes(raw)) {
          await ctx.reply(`⚠️ ${key}: ${ENUM_KEYS[key].join(' | ')}`);
          return;
        }
        patch = { [key]: raw } as Partial<AgentParams>;
      } else if ((HOURLIST_KEYS as readonly string[]).includes(key)) {
        const hours = raw === '-' ? [] : raw.split(',').map(Number).filter(h => Number.isInteger(h) && h >= 0 && h < 24);
        patch = { tradeHoursUtc: hours };
      } else if (EDITABLE_KEYS.includes(key as keyof AgentParams)) {
        const value = Number(raw);
        if (!Number.isFinite(value)) {
          await ctx.reply('⚠️ Значение должно быть числом');
          return;
        }
        patch = { [key]: value } as Partial<AgentParams>;
      } else {
        await ctx.reply(
          `⚠️ Ключ «${key}» нельзя менять. Доступны: ${EDITABLE_KEYS.join(', ')}, `
          + `${Object.keys(ENUM_KEYS).join(', ')}, tradeHoursUtc (напр. "7,8,9" или "-")`,
        );
        return;
      }

      const params = await deps.engine.applyParams(patch);
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
    // молчание бота хуже ошибки: сообщаем в чат, что команда упала
    if (ctx.updateType === 'message') {
      void ctx.reply(`⚠️ Команда не выполнилась: ${errMsg(err).slice(0, 200)}`).catch(() => {});
    }
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
