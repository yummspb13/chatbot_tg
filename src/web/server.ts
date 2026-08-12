// HTTP-сервер: /health (для Render), JSON API и статика мини-PWA.

import { createServer, Server } from 'node:http';
import path from 'node:path';
import compression from 'compression';
import express from 'express';
import { config } from '../config';
import { log } from '../logger';
import { egressMeter } from '../netmeter';
import { buildApiRouter, ApiDeps } from './api';
import { tgDiag, tgWebhook } from '../telegram/bot';

export function startWebServer(deps: ApiDeps): Server {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  // метр ДО compression: его обёртка res.write ловит байты, которые gzip
  // пишет в сокет — т.е. фактический провод, а не размер до сжатия
  app.use(egressMeter);
  // gzip всех ответов: JSON панели жмётся ~в 10 раз — экономия трафика Render,
  // лимит которого мы уже однажды сожгли (05.08, суспенд воркспейса)
  app.use(compression());

  app.get('/health', (_req, res) => {
    const s = deps.engine.status();
    // net/tg-диагностика публична сознательно: цифры трафика и транспорт бота
    // не секрет, а снимать их снаружи без авторизации — необходимость
    res.json({
      ok: true, running: s.running, mode: s.mode, ts: new Date().toISOString(), net: s.net,
      tg: { ...tgDiag, lastUpdateAgoSec: tgDiag.lastUpdateAt ? Math.round((Date.now() - tgDiag.lastUpdateAt) / 1000) : null },
    });
  });

  // Telegram-webhook: лениво (телеграм стартует после веб-сервера), путь
  // секретный (хэш токена). До /api и статики.
  app.use((req, res, next) => {
    const wh = tgWebhook();
    if (wh && req.path === wh.path) {
      wh.handler(req, res);
      return;
    }
    next();
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
