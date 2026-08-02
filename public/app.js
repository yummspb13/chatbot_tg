/* global uPlot */
// Логика мини-PWA: логин, статус-поллинг, управление агентом, график, push.

const $ = (id) => document.getElementById(id);

let equityPlot = null;
let statusTimer = null;
let dataTimer = null;

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    ...opts,
  });
  if (res.status === 401) {
    showLogin();
    throw new Error('unauthorized');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function fmtUsd(v) {
  const s = (v >= 0 ? '+' : '') + v.toFixed(2) + '$';
  return `<span class="${v >= 0 ? 'pos' : 'neg'}">${s}</span>`;
}

function showLogin() {
  clearInterval(statusTimer);
  clearInterval(dataTimer);
  $('app').classList.add('hidden');
  $('login').classList.remove('hidden');
}

function showApp() {
  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');
  refreshStatus();
  refreshData();
  clearInterval(statusTimer);
  clearInterval(dataTimer);
  statusTimer = setInterval(refreshStatus, 5000);
  dataTimer = setInterval(refreshData, 30000);
}

async function refreshStatus() {
  try {
    const { engine, settings, persistentStore, news, pendingProposals } = await api('/status');
    const badge = $('stateBadge');
    badge.textContent = engine.running ? 'работает' : 'остановлен';
    badge.className = 'badge ' + (engine.running ? 'on' : 'off');

    $('stMode').textContent = settings.mode === 'sim'
      ? 'sim (симулятор)'
      : `live → OANDA ${engine.oandaEnv}`;
    $('stQuote').textContent = engine.lastQuote
      ? `${engine.lastQuote.bid.toFixed(5)} / ${engine.lastQuote.ask.toFixed(5)} (${engine.lastQuoteAgoSec}с)`
      : '—';
    $('stAccount').textContent = engine.account
      ? `${engine.account.balance.toFixed(2)} / ${engine.account.equity.toFixed(2)} ${engine.account.currency}`
      : '—';
    $('stToday').innerHTML = `${fmtUsd(engine.realizedToday)} · сделок ${engine.tradesToday}`;

    const notes = [];
    if (!persistentStore) notes.push('⚠️ БД не подключена — MemoryStore');
    if (engine.fxWeekend) notes.push('выходные FX — входы заблокированы');
    const cr = engine.crypto;
    if (cr && cr.running) {
      notes.push(`🧪 крипто ${cr.symbol}: ${cr.entriesActive ? 'входы активны' : cr.haltedToday ? 'пауза (лимит дня)' : 'наблюдает'} · день ${fmtUsd(cr.realizedToday)} (${cr.tradesToday} сд)`);
    }
    const mk = engine.maker;
    if (mk && mk.running) {
      notes.push(`⚗️ мейкер-тестнет: ${mk.haltedToday ? 'пауза (лимит дня)' : mk.quiet ? 'котирует' : 'ждёт тишины'} · день ${fmtUsd(mk.realizedToday)} (${mk.tradesToday} кругов)`);
    }
    const mmk = engine.markets;
    if (mmk && mmk.running && mmk.markets) {
      notes.push(`🌍 мультирынок: ${mmk.markets.join(', ')}${mmk.lastQuoteAgoSec === null ? ' (рынки закрыты)' : ''}`);
    }
    if (engine.killSwitchAt) notes.push(`kill-switch: ${engine.killSwitchAt}`);
    if (engine.lastError) notes.push(`ошибка: ${engine.lastError}`);
    if (news.degraded) notes.push('календарь новостей недоступен');
    if (pendingProposals > 0) notes.push(`предложений обучения: ${pendingProposals}`);
    $('stNotes').textContent = notes.join(' · ');

    $('modeSelect').value = settings.mode;
  } catch (e) {
    if (e.message !== 'unauthorized') $('stNotes').textContent = 'нет связи: ' + e.message;
  }
}

async function refreshData() {
  try {
    const [{ points }, { trades }, { report, text }, { proposals }, { buckets }, { logs }, { ensemble }] = await Promise.all([
      api('/equity?hours=48'),
      api('/trades?limit=60'),
      api('/report'),
      api('/proposals'),
      api('/hour-stats'),
      api('/logs?limit=60'),
      api('/ensemble'),
    ]);
    drawEquity(points);
    drawTrades(trades);
    $('reportWindowLabel').textContent = `(${report.windowMin} мин)`;
    $('reportText').textContent = text;
    drawProposals(proposals);
    drawHourStats(buckets);
    drawEnsemble(ensemble);
    $('logs').textContent = logs
      .map((l) => `${l.ts.slice(11, 19)} ${l.level.toUpperCase().padEnd(7)} ${l.source ? '[' + l.source + '] ' : ''}${l.message}`)
      .reverse()
      .join('\n');
  } catch (e) {
    // молча — статус-поллинг покажет проблему
  }
}

function drawEnsemble(ensemble) {
  const tbody = document.querySelector('#ensembleTable tbody');
  if (!tbody) return;
  if (!ensemble || !ensemble.members) {
    tbody.innerHTML = '<tr><td colspan="7" class="muted">не запущен (нужен live-режим)</td></tr>';
    return;
  }
  tbody.innerHTML = ensemble.members
    .map((m) => {
      const lic = m.license === 'granted' ? '✅' : m.license === 'denied' ? '❌' : `⏳ ${m.trades14}/10`;
      return `<tr><td>${m.key}</td><td>${lic}</td><td>${m.trades14}</td>`
        + `<td class="${m.net14 >= 0 ? 'pos' : 'neg'}">${fmtUsd(m.net14)}</td>`
        + `<td>${m.expectancy14 >= 0 ? '+' : ''}${m.expectancy14}$</td><td>${m.winRate14}%</td>`
        + `<td>${fmtUsd(m.realizedToday)} / ${m.tradesToday} сд</td></tr>`;
    })
    .join('');
}

function drawEquity(points) {
  const el = $('equityChart');
  if (!points.length) {
    el.textContent = 'Пока нет данных (снапшоты пишутся раз в минуту при работающем агенте)';
    return;
  }
  const xs = points.map((p) => new Date(p.ts).getTime() / 1000);
  const equity = points.map((p) => p.equity);
  const balance = points.map((p) => p.balance);
  const data = [xs, equity, balance];
  const width = Math.min(el.clientWidth || 320, 660);
  if (equityPlot) {
    equityPlot.setData(data);
    return;
  }
  el.textContent = '';
  equityPlot = new uPlot({
    width,
    height: 220,
    series: [
      {},
      { label: 'equity', stroke: '#3fb68b', width: 2 },
      { label: 'баланс', stroke: '#8899b4', width: 1, dash: [4, 4] },
    ],
    axes: [
      { stroke: '#8899b4', grid: { stroke: '#22304d' } },
      { stroke: '#8899b4', grid: { stroke: '#22304d' } },
    ],
  }, data, el);
}

function drawTrades(trades) {
  const tbody = $('tradesTable').querySelector('tbody');
  tbody.innerHTML = trades.map((t) => {
    const exit = t.exitPrice ? t.exitPrice.toFixed(5) : '…';
    const pnl = t.pnl === null ? '<span class="muted">открыта</span>' : fmtUsd(t.pnl);
    const cost = ((t.costSpread || 0) + (t.costCommission || 0)).toFixed(2) + '$';
    return `<tr>
      <td>${t.id}</td>
      <td>${t.side === 'BUY' ? '🟢 BUY' : '🔴 SELL'} ${t.units}</td>
      <td>${t.entryPrice.toFixed(5)} → ${exit}</td>
      <td>${pnl}</td>
      <td class="muted">${cost}</td>
      <td class="muted">${t.closeReason || ''}</td>
    </tr>`;
  }).join('');
}

function drawProposals(proposals) {
  const el = $('proposals');
  const pending = proposals.filter((p) => p.status === 'pending');
  if (!pending.length) {
    el.textContent = 'Нет ожидающих предложений. Еженедельный ребэктест создаёт их сам (AUTO_RETRAIN=1) или запускайте вручную: npm run backtest -- --optimize';
    return;
  }
  el.innerHTML = pending.map((p) => `
    <div class="proposal">
      <div class="small mono">#${p.id} · ${new Date(p.createdAt).toLocaleString()}</div>
      <div class="small mono">${JSON.stringify(p.params)}</div>
      <div class="small muted mono">${JSON.stringify(p.backtestReport).slice(0, 200)}</div>
      <div class="row">
        <button class="btn primary" data-approve="${p.id}">Применить</button>
        <button class="btn" data-reject="${p.id}">Отклонить</button>
      </div>
    </div>`).join('');
  el.querySelectorAll('[data-approve]').forEach((b) => b.addEventListener('click', async () => {
    await api(`/proposals/${b.dataset.approve}/approve`, { method: 'POST' });
    refreshData();
  }));
  el.querySelectorAll('[data-reject]').forEach((b) => b.addEventListener('click', async () => {
    await api(`/proposals/${b.dataset.reject}/reject`, { method: 'POST' });
    refreshData();
  }));
}

function drawHourStats(buckets) {
  const tbody = $('hourTable').querySelector('tbody');
  if (!buckets.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="muted">Пока нет закрытых сделок</td></tr>';
    return;
  }
  tbody.innerHTML = buckets.map((b) => `<tr>
    <td>${String(b.hour).padStart(2, '0')}:00</td>
    <td>${b.n}</td>
    <td>${fmtUsd(b.pnl)}</td>
    <td>${fmtUsd(b.expectancy)}</td>
  </tr>`).join('');
}

async function loadParamsForm() {
  const { params, editable, enums } = await api('/params');
  const form = $('paramsForm');
  const enumKeys = Object.keys(enums || {});
  form.innerHTML = [
    ...enumKeys.map((key) => `
      <div>
        <label for="p_${key}">${key}</label>
        <select id="p_${key}">
          ${enums[key].map((v) => `<option value="${v}" ${params[key] === v ? 'selected' : ''}>${v}</option>`).join('')}
        </select>
      </div>`),
    `<div>
      <label for="p_tradeHoursUtc">tradeHoursUtc (напр. 7,8,9; пусто = все)</label>
      <input id="p_tradeHoursUtc" type="text" value="${(params.tradeHoursUtc || []).join(',')}">
    </div>`,
    ...editable.map((key) => `
      <div>
        <label for="p_${key}">${key}</label>
        <input id="p_${key}" type="number" step="any" value="${params[key]}">
      </div>`),
  ].join('');
  $('btnSaveParams').onclick = async () => {
    const patch = {};
    for (const key of editable) {
      const v = Number($(`p_${key}`).value);
      if (Number.isFinite(v)) patch[key] = v;
    }
    for (const key of enumKeys) patch[key] = $(`p_${key}`).value;
    const hoursRaw = $('p_tradeHoursUtc').value.trim();
    patch.tradeHoursUtc = hoursRaw
      ? hoursRaw.split(',').map((s) => Number(s.trim())).filter((h) => Number.isInteger(h) && h >= 0 && h < 24)
      : [];
    try {
      await api('/params', { method: 'POST', body: JSON.stringify(patch) });
      setMsg('✅ Параметры сохранены (с учётом жёстких лимитов)');
      loadParamsForm();
    } catch (e) {
      setMsg('⚠️ ' + e.message);
    }
  };
}

function setMsg(text) {
  $('actionMsg').textContent = text;
}

async function subscribePush() {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      setMsg('⚠️ Push не поддерживается этим браузером');
      return;
    }
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      setMsg('⚠️ Разрешение на уведомления не выдано');
      return;
    }
    const reg = await navigator.serviceWorker.ready;
    const { key } = await api('/push/key');
    if (!key) {
      setMsg('⚠️ Web Push не настроен на сервере');
      return;
    }
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key),
    });
    await api('/push/subscribe', { method: 'POST', body: JSON.stringify(sub.toJSON()) });
    setMsg('🔔 Уведомления включены: сводка раз в час + алерты');
  } catch (e) {
    setMsg('⚠️ Push: ' + e.message);
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

function bindActions() {
  $('loginBtn').addEventListener('click', async () => {
    try {
      await api('/login', { method: 'POST', body: JSON.stringify({ password: $('password').value }) });
      $('loginError').classList.add('hidden');
      showApp();
      loadParamsForm();
    } catch (e) {
      $('loginError').textContent = e.message;
      $('loginError').classList.remove('hidden');
    }
  });
  $('password').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('loginBtn').click();
  });

  $('btnStart').addEventListener('click', async () => {
    try { setMsg((await api('/agent/start', { method: 'POST' })).message); } catch (e) { setMsg('⚠️ ' + e.message); }
    refreshStatus();
  });
  $('btnStop').addEventListener('click', async () => {
    try { setMsg((await api('/agent/stop', { method: 'POST' })).message); } catch (e) { setMsg('⚠️ ' + e.message); }
    refreshStatus();
  });
  $('btnKill').addEventListener('click', async () => {
    if (!confirm('Закрыть ВСЕ позиции и остановить агента?')) return;
    try { setMsg((await api('/agent/kill', { method: 'POST' })).message); } catch (e) { setMsg('⚠️ ' + e.message); }
    refreshStatus();
  });
  $('btnMode').addEventListener('click', async () => {
    try { setMsg((await api('/mode', { method: 'POST', body: JSON.stringify({ mode: $('modeSelect').value }) })).message); } catch (e) { setMsg('⚠️ ' + e.message); }
    refreshStatus();
  });
  $('btnPush').addEventListener('click', subscribePush);
  $('btnLogout').addEventListener('click', async () => {
    await api('/logout', { method: 'POST' }).catch(() => {});
    showLogin();
  });
}

async function boot() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
  bindActions();
  try {
    const { authed, adminConfigured } = await api('/me');
    if (!adminConfigured) {
      $('login').classList.remove('hidden');
      $('loginError').textContent = 'ADMIN_PASSWORD не задан на сервере — админка выключена';
      $('loginError').classList.remove('hidden');
      return;
    }
    if (authed) {
      showApp();
      loadParamsForm();
    } else {
      showLogin();
    }
  } catch {
    showLogin();
  }
}

boot();
