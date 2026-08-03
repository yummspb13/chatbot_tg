// JSON API мини-PWA. Всё, кроме /api/login и /health, — только после логина.

import { Router, json } from 'express';
import { config } from '../config';
import { log } from '../logger';
import { errMsg } from '../logger';
import { AgentEngine } from '../agent/engine';
import { AgentParams, EDITABLE_KEYS, ENUM_KEYS, HOURLIST_KEYS } from '../agent/params';
import { newsStatus, upcomingNews } from '../news/calendar';
import { checkPassword, clearSessionCookie, isAuthed, requireAuth, setSessionCookie } from './auth';
import { pushPublicKey, pushReady } from './push';
import { computeHourStats } from '../learn/stats';
import type { TradeStore } from '../store';

export interface ApiDeps {
  engine: AgentEngine;
  store: TradeStore;
  buildHourlyReport: (windowMin: number) => Promise<string>;
}

export function buildApiRouter(deps: ApiDeps): Router {
  const r = Router();
  r.use(json({ limit: '100kb' }));

  r.post('/login', (req, res) => {
    if (!config.adminPassword) {
      res.status(503).json({ error: 'ADMIN_PASSWORD не задан — админка выключена' });
      return;
    }
    if (!checkPassword(req.body?.password)) {
      res.status(401).json({ error: 'неверный пароль' });
      return;
    }
    setSessionCookie(req, res);
    res.json({ ok: true });
  });

  r.post('/logout', (_req, res) => {
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  r.get('/me', (req, res) => {
    res.json({ authed: isAuthed(req), adminConfigured: !!config.adminPassword });
  });

  r.use(requireAuth);

  r.get('/status', async (_req, res) => {
    try {
      const settings = await deps.store.getSettings();
      const pending = await deps.store.listProposals('pending');
      res.json({
        engine: deps.engine.status(),
        settings,
        persistentStore: deps.store.persistent,
        news: { ...newsStatus(), upcoming: upcomingNews(24).slice(0, 5) },
        pushConfigured: pushReady(),
        pendingProposals: pending.length,
      });
    } catch (e) {
      res.status(500).json({ error: errMsg(e) });
    }
  });

  r.get('/trades', async (req, res) => {
    try {
      const settings = await deps.store.getSettings();
      const limit = Math.min(Number(req.query.limit) || 100, 500);
      // ?mode=virtual — сделки виртуальных участников (бумага); иначе режим агента
      const mode = req.query.mode === 'virtual' ? 'virtual' : settings.mode;
      res.json({ trades: await deps.store.listTrades(mode, limit) });
    } catch (e) {
      res.status(500).json({ error: errMsg(e) });
    }
  });

  r.get('/equity', async (req, res) => {
    try {
      const settings = await deps.store.getSettings();
      const hours = Math.min(Number(req.query.hours) || 48, 24 * 14);
      res.json({ points: await deps.store.equitySeries(settings.mode, hours) });
    } catch (e) {
      res.status(500).json({ error: errMsg(e) });
    }
  });

  // Кумулятивная PnL-кривая виртуального портфеля: у бумаги нет equity-снапшотов,
  // кривая строится из закрытых виртуальных сделок (сумма нарастающим итогом).
  r.get('/virtual/pnl', async (req, res) => {
    try {
      const hours = Math.min(Number(req.query.hours) || 168, 24 * 30);
      const since = new Date(Date.now() - hours * 3600_000);
      const closed = await deps.store.closedTradesSince('virtual', since);
      closed.sort((a, b) => (a.closedAt?.getTime() ?? 0) - (b.closedAt?.getTime() ?? 0));
      let cum = 0;
      const points = closed.map(t => {
        cum += t.pnl ?? 0;
        return { ts: t.closedAt, cum: +cum.toFixed(2) };
      });
      res.json({ points });
    } catch (e) {
      res.status(500).json({ error: errMsg(e) });
    }
  });

  r.get('/report', async (req, res) => {
    try {
      const windowMin = Math.min(Math.max(Number(req.query.window) || config.reportWindowMin, 15), 240);
      const settings = await deps.store.getSettings();
      const report = await deps.store.windowReport(settings.mode, windowMin);
      res.json({ report, text: await deps.buildHourlyReport(windowMin) });
    } catch (e) {
      res.status(500).json({ error: errMsg(e) });
    }
  });

  r.get('/hour-stats', async (_req, res) => {
    try {
      const settings = await deps.store.getSettings();
      res.json({ buckets: await computeHourStats(deps.store, settings.mode, 30) });
    } catch (e) {
      res.status(500).json({ error: errMsg(e) });
    }
  });

  r.get('/logs', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    res.json({ logs: log.getLogs(limit) });
  });

  r.get('/ensemble', async (_req, res) => {
    try {
      res.json({ ensemble: await deps.engine.ensembleStats() });
    } catch (e) {
      res.status(500).json({ error: errMsg(e) });
    }
  });

  r.post('/agent/start', async (_req, res) => {
    try {
      res.json({ message: await deps.engine.start() });
    } catch (e) {
      res.status(400).json({ error: errMsg(e) });
    }
  });

  r.post('/agent/stop', async (_req, res) => {
    try {
      res.json({ message: await deps.engine.stop() });
    } catch (e) {
      res.status(400).json({ error: errMsg(e) });
    }
  });

  r.post('/agent/kill', async (_req, res) => {
    try {
      res.json({ message: await deps.engine.kill('ручной kill из PWA') });
    } catch (e) {
      res.status(400).json({ error: errMsg(e) });
    }
  });

  r.get('/params', async (_req, res) => {
    const settings = await deps.store.getSettings();
    res.json({
      params: settings.params,
      editable: EDITABLE_KEYS,
      enums: ENUM_KEYS,
      hourLists: HOURLIST_KEYS,
    });
  });

  r.post('/params', async (req, res) => {
    try {
      const patch: Partial<AgentParams> = {};
      const body = (req.body ?? {}) as Record<string, unknown>;
      for (const key of EDITABLE_KEYS) {
        const v = body[key];
        if (typeof v === 'number' && Number.isFinite(v)) (patch as Record<string, number>)[key] = v;
      }
      for (const key of Object.keys(ENUM_KEYS)) {
        const v = body[key];
        if (typeof v === 'string' && ENUM_KEYS[key].includes(v)) {
          (patch as Record<string, string>)[key] = v;
        }
      }
      if (Array.isArray(body.tradeHoursUtc)) {
        patch.tradeHoursUtc = body.tradeHoursUtc
          .map(Number)
          .filter(h => Number.isInteger(h) && h >= 0 && h < 24);
      }
      const params = await deps.engine.applyParams(patch);
      res.json({ params });
    } catch (e) {
      res.status(400).json({ error: errMsg(e) });
    }
  });

  r.post('/mode', async (req, res) => {
    const mode = req.body?.mode;
    if (mode !== 'sim' && mode !== 'live') {
      res.status(400).json({ error: 'mode: sim | live' });
      return;
    }
    try {
      res.json({ message: await deps.engine.setMode(mode) });
    } catch (e) {
      res.status(400).json({ error: errMsg(e) });
    }
  });

  r.get('/proposals', async (_req, res) => {
    res.json({ proposals: await deps.store.listProposals() });
  });

  r.post('/proposals/:id/approve', async (req, res) => {
    try {
      const id = Number(req.params.id);
      const p = await deps.store.getProposal(id);
      if (!p || p.status !== 'pending') {
        res.status(404).json({ error: 'предложение не найдено или уже обработано' });
        return;
      }
      await deps.engine.applyParams(p.params);
      await deps.store.setProposalStatus(id, 'applied');
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: errMsg(e) });
    }
  });

  r.post('/proposals/:id/reject', async (req, res) => {
    const id = Number(req.params.id);
    await deps.store.setProposalStatus(id, 'rejected');
    res.json({ ok: true });
  });

  r.get('/push/key', (_req, res) => {
    res.json({ key: pushPublicKey() });
  });

  r.post('/push/subscribe', async (req, res) => {
    const sub = req.body;
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
      res.status(400).json({ error: 'некорректная подписка' });
      return;
    }
    await deps.store.savePushSub({ endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth });
    res.json({ ok: true });
  });

  return r;
}
