// Web Push для PWA: VAPID-ключи из env или автогенерация в data/vapid.json.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';
import { config } from '../config';
import { errMsg, log } from '../logger';
import type { TradeStore } from '../store';

const VAPID_FILE = path.join(process.cwd(), 'data', 'vapid.json');

let publicKey: string | null = null;
let ready = false;

export function initPush(): void {
  let pub = config.vapidPublicKey;
  let priv = config.vapidPrivateKey;
  if (!pub || !priv) {
    try {
      if (existsSync(VAPID_FILE)) {
        const saved = JSON.parse(readFileSync(VAPID_FILE, 'utf8'));
        pub = saved.publicKey;
        priv = saved.privateKey;
      } else {
        const keys = webpush.generateVAPIDKeys();
        mkdirSync(path.dirname(VAPID_FILE), { recursive: true });
        writeFileSync(VAPID_FILE, JSON.stringify(keys, null, 2));
        pub = keys.publicKey;
        priv = keys.privateKey;
        log.info('VAPID-ключи сгенерированы в data/vapid.json (для продакшена задайте VAPID_* в env)', undefined, 'push');
      }
    } catch (e) {
      log.warn(`web push выключен: ${errMsg(e)}`, undefined, 'push');
      return;
    }
  }
  if (!pub || !priv) return;
  webpush.setVapidDetails('mailto:admin@fx-agent.local', pub, priv);
  publicKey = pub;
  ready = true;
}

export function pushPublicKey(): string | null {
  return publicKey;
}

export function pushReady(): boolean {
  return ready;
}

export async function sendPushToAll(store: TradeStore, title: string, body: string): Promise<void> {
  if (!ready) return;
  const subs = await store.listPushSubs();
  const payload = JSON.stringify({ title, body });
  await Promise.all(subs.map(async sub => {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload,
      );
    } catch (e: unknown) {
      const status = (e as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        await store.deletePushSub(sub.endpoint);
        log.info('push-подписка удалена (endpoint недоступен)', undefined, 'push');
      } else {
        log.warn(`push: ${errMsg(e)}`, undefined, 'push');
      }
    }
  }));
}
