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
import { polyStore } from '../poly/store';
import type { TradeStore } from '../store';

export interface ApiDeps {
  engine: AgentEngine;
  store: TradeStore;
  buildHourlyReport: (windowMin: number) => Promise<string>;
}

// Прореживание кривых до ≤max точек (каждая n-я + последняя): панель рисует
// график шириной ~660px — тысячи точек не видны глазу, но оплачиваются трафиком
function thin<T>(points: T[], max = 400): T[] {
  if (points.length <= max) return points;
  const step = Math.ceil(points.length / max);
  const out = points.filter((_, i) => i % step === 0);
  if (out[out.length - 1] !== points[points.length - 1]) out.push(points[points.length - 1]);
  return out;
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
      res.json({ points: thin(await deps.store.equitySeries(settings.mode, hours)) });
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
      res.json({ points: thin(points) });
    } catch (e) {
      res.status(500).json({ error: errMsg(e) });
    }
  });

  // --- Polymarket-терминал /poly.html (план M7a) ---
  // Валидация asset: слаги строятся из этого куска — только [a-z0-9]
  const polyAsset = (v: unknown): string | undefined =>
    typeof v === 'string' && /^[a-z0-9]{1,12}$/.test(v) ? v : undefined;

  r.get('/poly/summary', async (_req, res) => {
    try {
      // null = коллектор не запущен (агент не в live или POLY=0) — экран честно скажет
      res.json({ summary: await deps.engine.polySummary() });
    } catch (e) {
      res.status(500).json({ error: errMsg(e) });
    }
  });

  r.get('/poly/snaps', async (req, res) => {
    try {
      const hours = Math.min(Math.max(Number(req.query.hours) || 6, 1), 72);
      const asset = polyAsset(req.query.asset) ?? 'btc';
      const rows = await polyStore().snaps(hours, asset);
      const points = rows.map(s => ({
        ts: s.ts, setSumAsk: s.setSumAsk, upAsk: s.upAsk, downAsk: s.downAsk,
        refPx: s.refPx, depthUsd: s.depthUsd, isEvent: s.isEvent,
      }));
      res.json({ asset, points: thin(points) });
    } catch (e) {
      res.status(500).json({ error: errMsg(e) });
    }
  });

  r.get('/poly/resolutions', async (req, res) => {
    try {
      const limit = Math.min(Math.max(Number(req.query.limit) || 96, 1), 300);
      const asset = polyAsset(req.query.asset);
      const rows = await polyStore().resolutions(limit, asset);
      res.json({
        resolutions: rows.map(x => ({
          slug: x.slug, asset: x.asset, endTs: x.endTs, outcome: x.outcome, closeUpPrice: x.closeUpPrice,
        })),
      });
    } catch (e) {
      res.status(500).json({ error: errMsg(e) });
    }
  });

  r.get('/poly/model', async (_req, res) => {
    try {
      // модель обучается офлайн (M5) и приезжает файлом в билде
      const { readFile } = await import('node:fs/promises');
      const raw = await readFile('data/poly-model.json', 'utf8').catch(() => null);
      res.json({ model: raw ? JSON.parse(raw) : null });
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
