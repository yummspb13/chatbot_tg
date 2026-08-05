// Хранилище сделок/настроек: PrismaStore (Postgres, таблицы agent_*) или
// MemoryStore (без DATABASE_URL — только для локального смоук-теста, данные теряются).

import { Prisma } from '@prisma/client';
import { getPrisma, hasDb } from './db';
import { log } from './logger';
import { config } from './config';
import { AgentParams, clampParams, DEFAULT_PARAMS } from './agent/params';
import type { Side } from './broker/types';

export interface SettingsState {
  mode: 'sim' | 'live';
  symbol: string;
  isRunning: boolean;
  params: AgentParams;
  killSwitchAt: Date | null;
}

export interface TradeRecord {
  id: number;
  mode: string;
  symbol: string;
  side: Side;
  units: number;
  entryPrice: number;
  exitPrice: number | null;
  slPrice: number | null;
  tpPrice: number | null;
  openedAt: Date;
  closedAt: Date | null;
  pnl: number | null;
  costSpread: number | null;
  costCommission: number | null;
  brokerTradeId: string | null;
  closeReason: string | null;
  spreadAtEntry: number | null;
  volAtEntry: number | null;
  hourUtc: number | null;
  newsDistMin: number | null;
}

export interface OpenTradeInput {
  mode: string;
  symbol: string;
  side: Side;
  units: number;
  entryPrice: number;
  slPrice: number | null;
  tpPrice: number | null;
  openedAt: Date;
  costSpread: number;
  costCommission: number;
  brokerTradeId: string | null;
  spreadAtEntry: number;
  volAtEntry: number;
  hourUtc: number;
  newsDistMin: number | null;
  paramsSnapshot: AgentParams;
}

export interface CloseTradeInput {
  exitPrice: number;
  closedAt: Date;
  pnl: number;
  closeReason: string;
}

export interface WindowReport {
  windowMin: number;
  closedCount: number;
  wins: number;
  pnl: number;
  openedCount: number;
  costs: number;
  openNow: number;
}

export interface ProposalRecord {
  id: number;
  params: AgentParams;
  backtestReport: unknown;
  status: string;
  createdAt: Date;
}

export interface PushSubRecord {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface EquityPoint {
  ts: Date;
  balance: number;
  equity: number;
}

export interface TradeStore {
  readonly persistent: boolean;
  getSettings(): Promise<SettingsState>;
  saveSettings(patch: Partial<SettingsState>): Promise<SettingsState>;
  openTrade(t: OpenTradeInput): Promise<TradeRecord>;
  closeTradeById(id: number, c: CloseTradeInput): Promise<void>;
  findOpenByBrokerId(mode: string, brokerTradeId: string): Promise<TradeRecord | null>;
  /** symbol задан → только сделки этого символа (FX-контур и крипто-нога не мешают друг другу) */
  listOpenTrades(mode: string, symbol?: string): Promise<TradeRecord[]>;
  countTradesToday(mode: string, symbol?: string): Promise<number>;
  realizedPnlToday(mode: string, symbol?: string): Promise<number>;
  windowReport(mode: string, windowMin: number): Promise<WindowReport>;
  listTrades(mode: string, limit: number): Promise<TradeRecord[]>;
  closedTradesSince(mode: string, since: Date): Promise<TradeRecord[]>;
  saveSnapshot(mode: string, balance: number, equity: number, openPositions: number): Promise<void>;
  equitySeries(mode: string, hours: number): Promise<EquityPoint[]>;
  /** Последний equity-снапшот любого режима — вотермарк «когда сервис жил в
   *  последний раз» для догонки виртуальных ног после простоя. */
  latestSnapshotTs(): Promise<Date | null>;
  createProposal(params: AgentParams, report: unknown): Promise<ProposalRecord>;
  listProposals(status?: string): Promise<ProposalRecord[]>;
  getProposal(id: number): Promise<ProposalRecord | null>;
  setProposalStatus(id: number, status: 'applied' | 'rejected'): Promise<void>;
  savePushSub(s: PushSubRecord): Promise<void>;
  listPushSubs(): Promise<PushSubRecord[]>;
  deletePushSub(endpoint: string): Promise<void>;
}

function utcDayStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

// ---------------------------------------------------------------- PrismaStore

class PrismaStore implements TradeStore {
  readonly persistent = true;
  private get p() { return getPrisma(); }

  async getSettings(): Promise<SettingsState> {
    const row = await this.p.agentSettings.upsert({
      where: { id: 1 },
      update: {},
      create: {
        id: 1,
        mode: config.agentModeDefault,
        symbol: config.symbolDefault,
        params: DEFAULT_PARAMS as unknown as Prisma.InputJsonValue,
      },
    });
    return {
      mode: row.mode === 'live' ? 'live' : 'sim',
      symbol: row.symbol,
      isRunning: row.isRunning,
      params: clampParams(row.params),
      killSwitchAt: row.killSwitchAt,
    };
  }

  async saveSettings(patch: Partial<SettingsState>): Promise<SettingsState> {
    const data: Prisma.AgentSettingsUpdateInput = {};
    if (patch.mode !== undefined) data.mode = patch.mode;
    if (patch.symbol !== undefined) data.symbol = patch.symbol;
    if (patch.isRunning !== undefined) data.isRunning = patch.isRunning;
    if (patch.params !== undefined) data.params = patch.params as unknown as Prisma.InputJsonValue;
    if (patch.killSwitchAt !== undefined) data.killSwitchAt = patch.killSwitchAt;
    await this.getSettings(); // ensure row exists
    await this.p.agentSettings.update({ where: { id: 1 }, data });
    return this.getSettings();
  }

  private mapTrade(t: {
    id: number; mode: string; symbol: string; side: string; units: number;
    entryPrice: number; exitPrice: number | null; slPrice: number | null; tpPrice: number | null;
    openedAt: Date; closedAt: Date | null; pnl: number | null; costSpread: number | null;
    costCommission: number | null; brokerTradeId: string | null; closeReason: string | null;
    spreadAtEntry: number | null; volAtEntry: number | null; hourUtc: number | null; newsDistMin: number | null;
  }): TradeRecord {
    return { ...t, side: t.side === 'SELL' ? 'SELL' : 'BUY' };
  }

  async openTrade(t: OpenTradeInput): Promise<TradeRecord> {
    const row = await this.p.trade.create({
      data: {
        mode: t.mode, symbol: t.symbol, side: t.side, units: t.units,
        entryPrice: t.entryPrice, slPrice: t.slPrice, tpPrice: t.tpPrice,
        openedAt: t.openedAt, costSpread: t.costSpread, costCommission: t.costCommission,
        brokerTradeId: t.brokerTradeId, spreadAtEntry: t.spreadAtEntry, volAtEntry: t.volAtEntry,
        hourUtc: t.hourUtc, newsDistMin: t.newsDistMin,
        paramsSnapshot: t.paramsSnapshot as unknown as Prisma.InputJsonValue,
      },
    });
    return this.mapTrade(row);
  }

  async closeTradeById(id: number, c: CloseTradeInput): Promise<void> {
    await this.p.trade.update({
      where: { id },
      data: { exitPrice: c.exitPrice, closedAt: c.closedAt, pnl: c.pnl, closeReason: c.closeReason },
    });
  }

  async findOpenByBrokerId(mode: string, brokerTradeId: string): Promise<TradeRecord | null> {
    const row = await this.p.trade.findFirst({ where: { mode, brokerTradeId, closedAt: null } });
    return row ? this.mapTrade(row) : null;
  }

  async listOpenTrades(mode: string, symbol?: string): Promise<TradeRecord[]> {
    const rows = await this.p.trade.findMany({
      where: { mode, closedAt: null, ...(symbol ? { symbol } : {}) },
      orderBy: { openedAt: 'asc' },
    });
    return rows.map(r => this.mapTrade(r));
  }

  async countTradesToday(mode: string, symbol?: string): Promise<number> {
    return this.p.trade.count({
      where: { mode, openedAt: { gte: utcDayStart() }, ...(symbol ? { symbol } : {}) },
    });
  }

  async realizedPnlToday(mode: string, symbol?: string): Promise<number> {
    const agg = await this.p.trade.aggregate({
      _sum: { pnl: true },
      where: { mode, closedAt: { gte: utcDayStart() }, ...(symbol ? { symbol } : {}) },
    });
    return agg._sum.pnl ?? 0;
  }

  async windowReport(mode: string, windowMin: number): Promise<WindowReport> {
    const since = new Date(Date.now() - windowMin * 60_000);
    const [closed, opened, openNow] = await Promise.all([
      this.p.trade.findMany({ where: { mode, closedAt: { gte: since } } }),
      this.p.trade.findMany({ where: { mode, openedAt: { gte: since } } }),
      this.p.trade.count({ where: { mode, closedAt: null } }),
    ]);
    return {
      windowMin,
      closedCount: closed.length,
      wins: closed.filter(t => (t.pnl ?? 0) > 0).length,
      pnl: closed.reduce((s, t) => s + (t.pnl ?? 0), 0),
      openedCount: opened.length,
      costs: opened.reduce((s, t) => s + (t.costSpread ?? 0) + (t.costCommission ?? 0), 0),
      openNow,
    };
  }

  async listTrades(mode: string, limit: number): Promise<TradeRecord[]> {
    const rows = await this.p.trade.findMany({ where: { mode }, orderBy: { openedAt: 'desc' }, take: limit });
    return rows.map(r => this.mapTrade(r));
  }

  async closedTradesSince(mode: string, since: Date): Promise<TradeRecord[]> {
    const rows = await this.p.trade.findMany({ where: { mode, closedAt: { gte: since } }, orderBy: { closedAt: 'asc' } });
    return rows.map(r => this.mapTrade(r));
  }

  async saveSnapshot(mode: string, balance: number, equity: number, openPositions: number): Promise<void> {
    await this.p.equitySnapshot.create({ data: { mode, balance, equity, openPositions } });
  }

  async latestSnapshotTs(): Promise<Date | null> {
    const r = await this.p.equitySnapshot.findFirst({ orderBy: { ts: 'desc' }, select: { ts: true } });
    return r?.ts ?? null;
  }

  async equitySeries(mode: string, hours: number): Promise<EquityPoint[]> {
    const since = new Date(Date.now() - hours * 3600_000);
    const rows = await this.p.equitySnapshot.findMany({
      where: { mode, ts: { gte: since } },
      orderBy: { ts: 'asc' },
      take: 2000,
    });
    return rows.map(r => ({ ts: r.ts, balance: r.balance, equity: r.equity }));
  }

  async createProposal(params: AgentParams, report: unknown): Promise<ProposalRecord> {
    const row = await this.p.paramProposal.create({
      data: {
        params: params as unknown as Prisma.InputJsonValue,
        backtestReport: (report ?? {}) as Prisma.InputJsonValue,
      },
    });
    return { id: row.id, params: clampParams(row.params), backtestReport: row.backtestReport, status: row.status, createdAt: row.createdAt };
  }

  async listProposals(status?: string): Promise<ProposalRecord[]> {
    const rows = await this.p.paramProposal.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    return rows.map(row => ({ id: row.id, params: clampParams(row.params), backtestReport: row.backtestReport, status: row.status, createdAt: row.createdAt }));
  }

  async getProposal(id: number): Promise<ProposalRecord | null> {
    const row = await this.p.paramProposal.findUnique({ where: { id } });
    return row ? { id: row.id, params: clampParams(row.params), backtestReport: row.backtestReport, status: row.status, createdAt: row.createdAt } : null;
  }

  async setProposalStatus(id: number, status: 'applied' | 'rejected'): Promise<void> {
    await this.p.paramProposal.update({ where: { id }, data: { status } });
  }

  async savePushSub(s: PushSubRecord): Promise<void> {
    await this.p.pushSubscription.upsert({
      where: { endpoint: s.endpoint },
      update: { p256dh: s.p256dh, auth: s.auth },
      create: s,
    });
  }

  async listPushSubs(): Promise<PushSubRecord[]> {
    const rows = await this.p.pushSubscription.findMany();
    return rows.map(r => ({ endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth }));
  }

  async deletePushSub(endpoint: string): Promise<void> {
    await this.p.pushSubscription.deleteMany({ where: { endpoint } });
  }
}

// ---------------------------------------------------------------- MemoryStore

class MemoryStore implements TradeStore {
  readonly persistent = false;
  private settings: SettingsState = {
    mode: config.agentModeDefault,
    symbol: config.symbolDefault,
    isRunning: false,
    params: { ...DEFAULT_PARAMS },
    killSwitchAt: null,
  };
  private trades: TradeRecord[] = [];
  private snapshots: (EquityPoint & { mode: string; openPositions: number })[] = [];
  private proposals: ProposalRecord[] = [];
  private pushSubs: PushSubRecord[] = [];
  private seq = 1;

  async getSettings(): Promise<SettingsState> {
    return { ...this.settings, params: { ...this.settings.params } };
  }

  async saveSettings(patch: Partial<SettingsState>): Promise<SettingsState> {
    this.settings = { ...this.settings, ...patch };
    return this.getSettings();
  }

  async openTrade(t: OpenTradeInput): Promise<TradeRecord> {
    const rec: TradeRecord = {
      id: this.seq++,
      mode: t.mode, symbol: t.symbol, side: t.side, units: t.units,
      entryPrice: t.entryPrice, exitPrice: null, slPrice: t.slPrice, tpPrice: t.tpPrice,
      openedAt: t.openedAt, closedAt: null, pnl: null,
      costSpread: t.costSpread, costCommission: t.costCommission,
      brokerTradeId: t.brokerTradeId, closeReason: null,
      spreadAtEntry: t.spreadAtEntry, volAtEntry: t.volAtEntry, hourUtc: t.hourUtc, newsDistMin: t.newsDistMin,
    };
    this.trades.push(rec);
    return rec;
  }

  async closeTradeById(id: number, c: CloseTradeInput): Promise<void> {
    const t = this.trades.find(x => x.id === id);
    if (!t) return;
    t.exitPrice = c.exitPrice;
    t.closedAt = c.closedAt;
    t.pnl = c.pnl;
    t.closeReason = c.closeReason;
  }

  async findOpenByBrokerId(mode: string, brokerTradeId: string): Promise<TradeRecord | null> {
    return this.trades.find(t => t.mode === mode && t.brokerTradeId === brokerTradeId && !t.closedAt) ?? null;
  }

  async listOpenTrades(mode: string, symbol?: string): Promise<TradeRecord[]> {
    return this.trades.filter(t => t.mode === mode && !t.closedAt && (!symbol || t.symbol === symbol));
  }

  async countTradesToday(mode: string, symbol?: string): Promise<number> {
    const start = utcDayStart();
    return this.trades.filter(t => t.mode === mode && t.openedAt >= start && (!symbol || t.symbol === symbol)).length;
  }

  async realizedPnlToday(mode: string, symbol?: string): Promise<number> {
    const start = utcDayStart();
    return this.trades
      .filter(t => t.mode === mode && t.closedAt && t.closedAt >= start && (!symbol || t.symbol === symbol))
      .reduce((s, t) => s + (t.pnl ?? 0), 0);
  }

  async windowReport(mode: string, windowMin: number): Promise<WindowReport> {
    const since = new Date(Date.now() - windowMin * 60_000);
    const closed = this.trades.filter(t => t.mode === mode && t.closedAt && t.closedAt >= since);
    const opened = this.trades.filter(t => t.mode === mode && t.openedAt >= since);
    return {
      windowMin,
      closedCount: closed.length,
      wins: closed.filter(t => (t.pnl ?? 0) > 0).length,
      pnl: closed.reduce((s, t) => s + (t.pnl ?? 0), 0),
      openedCount: opened.length,
      costs: opened.reduce((s, t) => s + (t.costSpread ?? 0) + (t.costCommission ?? 0), 0),
      openNow: this.trades.filter(t => t.mode === mode && !t.closedAt).length,
    };
  }

  async listTrades(mode: string, limit: number): Promise<TradeRecord[]> {
    return this.trades.filter(t => t.mode === mode).slice(-limit).reverse();
  }

  async closedTradesSince(mode: string, since: Date): Promise<TradeRecord[]> {
    return this.trades.filter(t => t.mode === mode && t.closedAt && t.closedAt >= since);
  }

  async saveSnapshot(mode: string, balance: number, equity: number, openPositions: number): Promise<void> {
    this.snapshots.push({ ts: new Date(), mode, balance, equity, openPositions });
    if (this.snapshots.length > 5000) this.snapshots.shift();
  }

  async equitySeries(mode: string, hours: number): Promise<EquityPoint[]> {
    const since = Date.now() - hours * 3600_000;
    return this.snapshots
      .filter(s => s.mode === mode && s.ts.getTime() >= since)
      .map(s => ({ ts: s.ts, balance: s.balance, equity: s.equity }));
  }

  async latestSnapshotTs(): Promise<Date | null> {
    return this.snapshots.length ? this.snapshots[this.snapshots.length - 1].ts : null;
  }

  async createProposal(params: AgentParams, report: unknown): Promise<ProposalRecord> {
    const rec: ProposalRecord = { id: this.seq++, params, backtestReport: report, status: 'pending', createdAt: new Date() };
    this.proposals.push(rec);
    return rec;
  }

  async listProposals(status?: string): Promise<ProposalRecord[]> {
    return this.proposals.filter(p => !status || p.status === status).slice(-20).reverse();
  }

  async getProposal(id: number): Promise<ProposalRecord | null> {
    return this.proposals.find(p => p.id === id) ?? null;
  }

  async setProposalStatus(id: number, status: 'applied' | 'rejected'): Promise<void> {
    const p = this.proposals.find(x => x.id === id);
    if (p) p.status = status;
  }

  async savePushSub(s: PushSubRecord): Promise<void> {
    this.pushSubs = this.pushSubs.filter(x => x.endpoint !== s.endpoint);
    this.pushSubs.push(s);
  }

  async listPushSubs(): Promise<PushSubRecord[]> {
    return [...this.pushSubs];
  }

  async deletePushSub(endpoint: string): Promise<void> {
    this.pushSubs = this.pushSubs.filter(x => x.endpoint !== endpoint);
  }
}

export function createStore(): TradeStore {
  if (hasDb()) return new PrismaStore();
  log.warn('DATABASE_URL не задан — используется MemoryStore: сделки и настройки НЕ сохраняются между рестартами', undefined, 'store');
  return new MemoryStore();
}
