// HTTP-сервер: /health (для Render), JSON API и статика мини-PWA.

import { createServer, Server } from 'node:http';
import path from 'node:path';
import express from 'express';
import { config } from '../config';
import { log } from '../logger';
import { buildApiRouter, ApiDeps } from './api';

export function startWebServer(deps: ApiDeps): Server {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.get('/health', (_req, res) => {
    const s = deps.engine.status();
    res.json({ ok: true, running: s.running, mode: s.mode, ts: new Date().toISOString() });
  });

  app.use('/api', buildApiRouter(deps));

  const publicDir = path.join(process.cwd(), 'public');
  app.use(express.static(publicDir, {
    setHeaders(res, filePath) {
      if (filePath.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache');
      if (filePath.endsWith('.webmanifest')) res.setHeader('Content-Type', 'application/manifest+json');
    },
  }));

  const server = createServer(app);
  server.listen(config.port, () => {
    log.success(`HTTP-сервер запущен на порту ${config.port} (/health, /api, PWA)`, undefined, 'web');
  });
  return server;
}
