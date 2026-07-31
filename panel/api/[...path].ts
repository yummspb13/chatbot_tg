// FX Agent — панель на Vercel: прокси всего трафика к агенту на Render.
// Файл-catch-all api/[...path].ts перехватывает ЛЮБОЙ /api/* (Vercel не пускает
// несуществующие /api-пути в rewrites), а не-API пути приходят сюда рерайтом
// с query-параметром ?p=<путь>. AGENT_URL в env переопределяет вшитый дефолт.

const DEFAULT_AGENT_URL = 'https://chatbot-tg-1.onrender.com';

export default async function handler(req: any, res: any) {
  const base = (process.env.AGENT_URL || DEFAULT_AGENT_URL).replace(/\/+$/, '');
  const q: Record<string, unknown> = { ...(req.query || {}) };

  let path: string;
  if (q.p !== undefined) {
    // не-API путь, пришёл рерайтом: ?p=styles.css, ?p= (корень)
    const p = q.p;
    path = Array.isArray(p) ? p.join('/') : String(p);
    delete q.p;
    delete q.path; // сегмент самого файла-функции (например "r") — не нужен
  } else {
    // прямой /api/*: сегменты в q.path от [...path]
    const seg = q.path;
    path = 'api/' + (Array.isArray(seg) ? seg.join('/') : String(seg ?? ''));
    delete q.path;
  }

  const qs = new URLSearchParams(q as Record<string, string>).toString();
  const target = `${base}/${path}${qs ? `?${qs}` : ''}`;

  const headers: Record<string, string> = {};
  if (req.headers.cookie) headers.cookie = String(req.headers.cookie);
  if (req.headers['content-type']) headers['content-type'] = String(req.headers['content-type']);

  const method = req.method || 'GET';
  const body = method === 'GET' || method === 'HEAD'
    ? undefined
    : (typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {}));

  try {
    const r = await fetch(target, { method, headers, body, redirect: 'manual' });
    const setCookie = r.headers.get('set-cookie');
    if (setCookie) res.setHeader('set-cookie', setCookie);
    const ct = r.headers.get('content-type');
    if (ct) res.setHeader('content-type', ct);
    const cc = r.headers.get('cache-control');
    if (cc) res.setHeader('cache-control', cc);
    const buf = Buffer.from(await r.arrayBuffer());
    res.status(r.status).send(buf);
  } catch (e: any) {
    res.status(502).setHeader('content-type', 'text/html; charset=utf-8');
    res.send(`<div style="font-family:sans-serif;max-width:520px;margin:20vh auto;color:#e7edf7;background:#0b1220;padding:24px;border-radius:12px"><h3>Агент недоступен</h3><p>${(e && e.message) || e}</p><p>Render Free засыпает — обновите страницу через минуту, он проснётся. Если не помогает — проверьте сервис на Render.</p></div>`);
  }
}
