// FX Agent — панель на Vercel.
// Движок агента — долгоживущий процесс и живёт на Render; Vercel (serverless)
// раздаёт его PWA через этот прокси: стабильный URL, куки и статика проходят насквозь.
// Настройка: Vercel → проект → Settings → Environment Variables → AGENT_URL =
// https://<ваш-сервис>.onrender.com, затем Redeploy.

export default async function handler(req: any, res: any) {
  const base = (process.env.AGENT_URL || '').replace(/\/+$/, '');
  if (!base) {
    res.status(503).setHeader('content-type', 'text/html; charset=utf-8');
    res.send('<div style="font-family:sans-serif;max-width:520px;margin:20vh auto;color:#e7edf7;background:#0b1220;padding:24px;border-radius:12px"><h3>Панель FX Agent: AGENT_URL не задан</h3><p>Vercel → проект fx-agent → Settings → Environment Variables → добавьте <b>AGENT_URL</b> = URL агента на Render (например https://fx-agent.onrender.com) и сделайте Redeploy.</p></div>');
    return;
  }
  const q: Record<string, unknown> = { ...(req.query || {}) };
  const parts = q.path;
  delete q.path;
  const path = Array.isArray(parts) ? parts.join('/') : String(parts || '');
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
    res.send(`<div style="font-family:sans-serif;max-width:520px;margin:20vh auto;color:#e7edf7;background:#0b1220;padding:24px;border-radius:12px"><h3>Агент недоступен</h3><p>${(e && e.message) || e}</p><p>Проверьте сервис на Render и переменную AGENT_URL.</p></div>`);
  }
}
