// Service worker PWA: офлайн-шелл + Web Push уведомления.

const CACHE = 'fx-agent-v1';
const SHELL = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/uplot.min.js',
  '/uplot.min.css',
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // API всегда по сети
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request)),
  );
});

self.addEventListener('push', (e) => {
  let data = { title: 'FX Agent', body: '' };
  try { data = e.data.json(); } catch { data.body = e.data ? e.data.text() : ''; }
  e.waitUntil(self.registration.showNotification(data.title || 'FX Agent', {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) return c.focus();
      }
      return clients.openWindow('/');
    }),
  );
});
