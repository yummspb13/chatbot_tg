/* global uPlot */
// Polymarket-терминал: живой экран коллектора 5-минуток (план M7a).
// Поллинг экономный (трафик Render — святое): summary 10с, ряды 60с,
// свёрнутая вкладка не поллит; прогресс бакета тикает локально (0 запросов).

const $ = (id) => document.getElementById(id);

let curAsset = 'btc';
let summary = null;          // последний /poly/summary
let summaryAt = 0;           // когда получен (для поправки lastPollAgoSec)
let lastPriceData = null;    // кэш для перерисовки на resize
let lastSumData = null;
let pricePlot = null;
let sumPlot = null;
let sumTimer = null;
let dataTimer = null;
let localTimer = null;
let lastTickerHtml = '';

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

function showLogin() {
  stopTimers();
  $('term').classList.add('hidden');
  $('login').classList.remove('hidden');
}

function startTimers() {
  stopTimers();
  sumTimer = setInterval(refreshSummary, 10000);
  dataTimer = setInterval(refreshData, 60000);
  localTimer = setInterval(localTick, 1000);
}

function stopTimers() {
  clearInterval(sumTimer);
  clearInterval(dataTimer);
  clearInterval(localTimer);
}

function showTerm() {
  $('login').classList.add('hidden');
  $('term').classList.remove('hidden');
  buildStubs();
  drawModel(); // один раз: файл модели статичен в билде
  refreshSummary();
  refreshData();
  startTimers();
  if (!document.body.dataset.visWired) {
    document.body.dataset.visWired = '1';
    document.addEventListener('visibilitychange', () => {
      if ($('term').classList.contains('hidden')) return;
      if (document.visibilityState === 'visible') {
        refreshSummary();
        refreshData();
        startTimers();
      } else {
        stopTimers();
      }
    });
    $('assetSel').addEventListener('change', () => {
      curAsset = $('assetSel').value;
      refreshData();
      localTick();
    });
    let rt = null;
    window.addEventListener('resize', () => {
      clearTimeout(rt);
      rt = setTimeout(() => {
        if (pricePlot) { pricePlot.destroy(); pricePlot = null; }
        if (sumPlot) { sumPlot.destroy(); sumPlot = null; }
        if (lastPriceData) drawPrice(lastPriceData);
        if (lastSumData) drawSum(lastSumData);
      }, 300);
    });
  }
}

// ---------- summary (10с) ----------

async function refreshSummary() {
  try {
    const r = await api('/poly/summary');
    summary = r.summary;
    summaryAt = Date.now();
    renderSummary();
  } catch (e) {
    if (e.message !== 'unauthorized') {
      $('connBadge').textContent = 'нет связи';
      $('connBadge').className = 'badge off';
    }
  }
}

function renderSummary() {
  const badge = $('connBadge');
  const off = $('offNote');
  if (!summary) {
    badge.textContent = 'коллектор выключен';
    badge.className = 'badge off';
    off.textContent = '⚠️ Polymarket-коллектор не запущен: нужен работающий агент в live-режиме (и POLY≠0). Данные ниже — последние сохранённые.';
    off.classList.remove('hidden');
    return;
  }
  off.classList.add('hidden');
  const ago = liveAgoSec();
  badge.textContent = summary.running ? `live · опрос ${ago === null ? '—' : ago + 'с'} назад` : 'остановлен';
  badge.className = 'badge ' + (summary.running && ago !== null && ago < 60 ? 'on' : 'off');

  // селектор активов — по факту из коллектора
  const sel = $('assetSel');
  const assets = summary.assets || ['btc'];
  if (sel.options.length !== assets.length) {
    sel.innerHTML = assets.map((a) => `<option value="${a}">${a.toUpperCase()}</option>`).join('');
    sel.value = assets.includes(curAsset) ? curAsset : assets[0];
    curAsset = sel.value;
  }

  $('kSnaps').textContent = fmtInt(summary.snapsToday);
  $('kWindows').textContent = fmtInt(summary.windowsToday);
  $('kRes').textContent = fmtInt(summary.resolutionsToday);
  $('kReq').textContent = summary.reqPerMin ?? '—';
  localTick(); // сразу обновить lifecycle/статусбар без ожидания секунды
}

function liveAgoSec() {
  if (!summary || summary.lastPollAgoSec === null || summary.lastPollAgoSec === undefined) return null;
  return Math.round(summary.lastPollAgoSec + (Date.now() - summaryAt) / 1000);
}

function fmtInt(v) {
  return (v === null || v === undefined || v < 0) ? '—' : Number(v).toLocaleString('ru-RU');
}

// ---------- локальный тик 1с: lifecycle + статусбар ----------

function localTick() {
  const pa = summary && summary.perAsset ? summary.perAsset.find((x) => x.asset === curAsset) : null;
  const now = Date.now();

  if (pa && pa.endDateMs) {
    const secToEnd = Math.round((pa.endDateMs - now) / 1000);
    const elapsed = 300 - Math.max(0, secToEnd);
    $('lifeFill').style.width = Math.max(0, Math.min(100, (elapsed / 300) * 100)) + '%';
    $('lifeSlug').textContent = pa.slug || '';
    const chip = $('lifePhase');
    if (secToEnd > 60) {
      chip.textContent = 'торгуется';
      chip.className = 'phase-chip';
      $('lifeLeft').textContent = fmtMMSS(secToEnd) + ' до конца';
    } else if (secToEnd > 0) {
      chip.textContent = 'TWAP-окно 60с';
      chip.className = 'phase-chip twap';
      $('lifeLeft').textContent = fmtMMSS(secToEnd) + ' до конца';
    } else {
      chip.textContent = 'ждём резолюцию';
      chip.className = 'phase-chip resolve';
      $('lifeLeft').textContent = '+' + Math.min(999, -secToEnd) + 'с после конца';
    }
    const f = (v) => (v === null || v === undefined ? '—' : Number(v).toFixed(2));
    $('bookNow').innerHTML =
      `<span class="pos">UP ${f(pa.upBid)}/${f(pa.upAsk)}</span> · ` +
      `<span class="neg">DOWN ${f(pa.downBid)}/${f(pa.downAsk)}</span> · ` +
      `сет $${pa.setSumAsk === null || pa.setSumAsk === undefined ? '—' : pa.setSumAsk.toFixed(3)} · ` +
      `глубина $${pa.depthUsd === null || pa.depthUsd === undefined ? '—' : pa.depthUsd}` +
      (pa.refPx ? ` · ref $${Number(pa.refPx).toLocaleString('ru-RU')}` : '');
  } else if (!summary) {
    $('lifeLeft').textContent = '—';
  } else {
    $('lifePhase').textContent = 'нет активного рынка';
    $('lifePhase').className = 'phase-chip';
    $('lifeLeft').textContent = '—';
    $('lifeFill').style.width = '0%';
  }

  const utc = new Date().toISOString().slice(11, 19);
  const s = summary;
  $('statusbar').textContent = s
    ? `req/мин ${s.reqPerMin ?? '—'}/30 · снапов ${fmtInt(s.snapsToday)} (событийных ${fmtInt(s.eventsToday)}) · ` +
      `окон<$1 ${fmtInt(s.windowsToday)} · резолюций ${fmtInt(s.resolutionsToday)} · ` +
      `CF403 ${s.cf403 ?? 0} · ошибок ${s.errors ?? 0} · опрос ${liveAgoSec() ?? '—'}с назад · ${utc} UTC`
    : `коллектор офлайн · ${utc} UTC`;
}

function fmtMMSS(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ---------- данные (60с): графики, сетка, тикер ----------

async function refreshData() {
  try {
    const wantBtcExtra = curAsset !== 'btc';
    const [snaps, res, btcSnaps] = await Promise.all([
      api(`/poly/snaps?hours=6&asset=${curAsset}`),
      api(`/poly/resolutions?limit=96&asset=${curAsset}`),
      wantBtcExtra ? api('/poly/snaps?hours=6&asset=btc') : null,
    ]);
    drawPrice((wantBtcExtra ? btcSnaps : snaps).points);
    drawSum(snaps.points);
    drawResGrid(res.resolutions);
    buildTicker(res.resolutions);
  } catch (e) {
    // молча — бейдж summary покажет проблему связи
  }
}

const AXIS = { stroke: '#8899b4', grid: { stroke: '#1d2a45' } };

function drawPrice(points) {
  lastPriceData = points;
  const el = $('priceChart');
  const pts = (points || []).filter((p) => p.refPx !== null && p.refPx !== undefined);
  if (!pts.length) {
    // существующий график не сносим: пустой ответ не должен убить DOM uPlot
    if (!pricePlot) el.textContent = 'Пока нет референс-цены (пишется при живом BTC-стриме MT5)';
    return;
  }
  const data = [pts.map((p) => new Date(p.ts).getTime() / 1000), pts.map((p) => p.refPx)];
  if (pricePlot) { pricePlot.setData(data); return; }
  el.textContent = '';
  pricePlot = new uPlot({
    width: Math.min(el.clientWidth || 320, 760),
    height: 190,
    series: [{}, { label: 'BTC $', stroke: '#3fb68b', width: 2, points: { show: false } }],
    // гаттер шире дефолта: «64 500» не влезает в 50px и обрезается до «4 500»
    axes: [AXIS, { ...AXIS, size: 68, values: (_u, sp) => sp.map((v) => Number(v).toLocaleString('ru-RU')) }],
  }, data, el);
}

function drawSum(points) {
  lastSumData = points;
  const el = $('sumChart');
  const pts = (points || []).filter((p) => p.setSumAsk !== null && p.setSumAsk !== undefined);
  if (!pts.length) {
    if (!sumPlot) el.textContent = 'Пока нет снапов стакана за окно (6ч)';
    return;
  }
  const data = [pts.map((p) => new Date(p.ts).getTime() / 1000), pts.map((p) => p.setSumAsk)];
  if (sumPlot) { sumPlot.setData(data); return; }
  el.textContent = '';
  sumPlot = new uPlot({
    width: Math.min(el.clientWidth || 320, 760),
    height: 190,
    series: [{}, { label: 'UPask+DOWNask $', stroke: '#c9a227', width: 2, points: { show: false } }],
    // шкала всегда включает $1.00 — линия окна видна даже при плоской кривой
    scales: { y: { range: (u, min, max) => [Math.min(min, 0.99), Math.max(max, 1.01)] } },
    axes: [AXIS, AXIS],
    hooks: {
      draw: [
        (u) => {
          // зона <$1.00: всё ниже линии — окно сет-арбитража
          const y1 = u.valToPos(1.0, 'y', true);
          const { left, width: w, top, height: h } = u.bbox;
          const bottom = top + h;
          const ctx = u.ctx;
          ctx.save();
          if (y1 < bottom) {
            ctx.fillStyle = 'rgba(63, 182, 139, 0.10)';
            ctx.fillRect(left, Math.max(y1, top), w, bottom - Math.max(y1, top));
          }
          ctx.strokeStyle = 'rgba(63, 182, 139, 0.8)';
          ctx.setLineDash([5, 5]);
          ctx.beginPath();
          ctx.moveTo(left, y1);
          ctx.lineTo(left + w, y1);
          ctx.stroke();
          ctx.restore();
        },
      ],
    },
  }, data, el);
}

function drawResGrid(resolutions) {
  const el = $('resGrid');
  if (!resolutions || !resolutions.length) {
    el.innerHTML = '<div class="empty">Резолюций пока нет — коллектор пишет их каждые 5 минут работы</div>';
    $('resStats').textContent = '';
    return;
  }
  el.innerHTML = resolutions.map((r) => {
    const up = r.outcome === 'up';
    const cents = r.closeUpPrice === null || r.closeUpPrice === undefined
      ? '—'
      : Math.round(r.closeUpPrice * 100) + '¢';
    const t = new Date(r.endTs).toISOString().slice(11, 16);
    return `<div class="cell ${up ? 'up' : 'down'}" title="${r.slug} · ${t} UTC · ${up ? 'UP' : 'DOWN'} · закрытие UP ${cents}">` +
      `<span class="glyph">${up ? '▲' : '▼'}</span>${cents}</div>`;
  }).join('');
  const ups = resolutions.filter((r) => r.outcome === 'up').length;
  const share = Math.round((ups / resolutions.length) * 100);
  $('resStats').textContent =
    `${resolutions.length} экспираций: ▲ UP ${ups} (${share}%) · ▼ DOWN ${resolutions.length - ups} (${100 - share}%) — новые слева`;
}

function buildTicker(resolutions) {
  const items = [];
  if (summary && summary.perAsset) {
    for (const pa of summary.perAsset) {
      if (pa.setSumAsk !== null && pa.setSumAsk !== undefined) {
        items.push(`${pa.asset.toUpperCase()} сет $${pa.setSumAsk.toFixed(3)}${pa.setSumAsk < 1 ? ' 🟢 ОКНО' : ''}`);
      }
    }
    items.push(`окон<$1 сегодня: ${fmtInt(summary.windowsToday)}`);
  }
  for (const r of (resolutions || []).slice(0, 12)) {
    const t = new Date(r.endTs).toISOString().slice(11, 16);
    items.push(`${r.asset.toUpperCase()} ${t} ${r.outcome === 'up' ? '▲ UP' : '▼ DOWN'} ${r.closeUpPrice === null ? '' : Math.round(r.closeUpPrice * 100) + '¢'}`);
  }
  if (!items.length) items.push('лента пуста — ждём первые данные коллектора');
  const half = items.map((x) => `<span>${x}</span>`).join('<span class="sep">◆</span>');
  const html = half + '<span class="sep">◆</span>' + half; // дубль для бесшовной прокрутки
  if (html !== lastTickerHtml) {
    lastTickerHtml = html;
    $('tickerTrack').innerHTML = html;
  }
}

// ---------- SVG-заглушки этапов (честно подписаны в HTML) ----------

function buildStubs() {
  const n = $('neuralSvg');
  if (n && !n.childNodes.length) {
    // до загрузки модели — призрачный скелет; drawModel() заменит живыми весами
    const layers = [4, 6, 6, 2];
    const xs = [30, 110, 190, 270];
    const posY = (cnt, i) => 20 + (i + 0.5) * (130 / cnt);
    let svg = '';
    for (let l = 0; l < layers.length - 1; l++) {
      for (let i = 0; i < layers[l]; i++) {
        for (let j = 0; j < layers[l + 1]; j++) {
          svg += `<line class="edge" x1="${xs[l]}" y1="${posY(layers[l], i)}" x2="${xs[l + 1]}" y2="${posY(layers[l + 1], j)}"/>`;
        }
      }
    }
    layers.forEach((cnt, l) => {
      for (let i = 0; i < cnt; i++) svg += `<circle class="node" cx="${xs[l]}" cy="${posY(cnt, i)}" r="6"/>`;
    });
    svg += '<text x="14" y="165">mom/vol/позиция в баре</text><text x="292" y="165" text-anchor="end">P(up)/P(down)</text>';
    n.innerHTML = svg;
  }

  const e = $('edgeSvg');
  if (e && !e.childNodes.length) {
    const dots = [[70, 110], [100, 95], [130, 85], [160, 70], [190, 55], [220, 45], [120, 60], [180, 90]]
      .map(([x, y]) => `<circle class="dot" cx="${x}" cy="${y}" r="4"/>`).join('');
    e.innerHTML =
      '<line class="axis" x1="40" y1="15" x2="40" y2="140"/><line class="axis" x1="40" y1="140" x2="290" y2="140"/>' +
      '<line class="edge" x1="40" y1="140" x2="290" y2="15" stroke-dasharray="4 4"/>' + dots +
      '<text x="120" y="158">рынок P(up)</text><text x="8" y="12">модель</text>';
  }

  const h = $('hedgeSvg');
  if (h && !h.childNodes.length) {
    h.innerHTML =
      '<path class="ribbon" d="M20,50 C110,50 150,35 280,30 L280,50 C150,55 110,70 20,70 Z"/>' +
      '<path class="ribbon" d="M20,85 C110,85 150,80 280,75 L280,95 C150,100 110,105 20,105 Z"/>' +
      '<path class="ribbon" d="M20,120 C110,120 150,125 280,120 L280,140 C150,145 110,140 20,140 Z"/>' +
      '<text x="20" y="40">покупки UP/DOWN</text><text x="130" y="20">полные сеты &lt;$1</text><text x="240" y="160">won / lost</text>';
  }
}

// ---------- Neural Shell: живые веса модели (M5) ----------

const FEATURE_LABELS = {
  ret1: 'ret 1м', mom3: 'mom 3м', mom5: 'mom 5м',
  drift5: 'ход бакета', volRatio: 'вола 30м', prevOut: 'исход t−1',
};

async function drawModel() {
  let model = null;
  try {
    model = (await api('/poly/model')).model;
  } catch (e) {
    return; // нет связи — остаётся заглушка
  }
  const svgEl = $('neuralSvg');
  if (!model || !model.weights || !svgEl) return;
  const names = model.featureNames || [];
  const ws = model.weights;
  const maxW = Math.max(...ws.map((w) => Math.abs(w)), 1e-6);
  const yIn = (i) => 18 + (i + 0.5) * (128 / names.length);
  const OUT = { x: 262, y: 82 };
  let svg = '';
  names.forEach((f, i) => {
    const w = ws[i];
    const th = 0.6 + 3.4 * (Math.abs(w) / maxW);
    svg += `<line x1="96" y1="${yIn(i)}" x2="${OUT.x - 14}" y2="${OUT.y}" stroke="${w >= 0 ? '#3fb68b' : '#e5534b'}" stroke-width="${th.toFixed(1)}" opacity="0.75"><title>${f}: w=${w.toFixed(3)}</title></line>`;
  });
  names.forEach((f, i) => {
    svg += `<circle class="node" cx="90" cy="${yIn(i)}" r="6"/>` +
      `<text x="84" y="${yIn(i) + 3}" text-anchor="end">${FEATURE_LABELS[f] || f} ${ws[i] >= 0 ? '+' : ''}${ws[i].toFixed(2)}</text>`;
  });
  svg += `<circle class="node" cx="${OUT.x}" cy="${OUT.y}" r="9"/><text x="${OUT.x}" y="${OUT.y + 22}" text-anchor="middle">P(up)</text>`;
  svgEl.innerHTML = svg;
  svgEl.classList.add('live');

  const panel = svgEl.closest('.panel');
  const stage = panel && panel.querySelector('.stage');
  const note = panel && panel.querySelector('.stub-note');
  const m = model.metrics && model.metrics.test;
  if (stage) {
    stage.textContent = model.verdict === 'licensed' ? 'ЛИЦЕНЗИРОВАНА' : 'REJECTED';
    stage.classList.add(model.verdict === 'licensed' ? 'v-ok' : 'v-no');
  }
  if (note && m) {
    note.textContent = `логистическая регрессия (M5): тест acc ${(m.acc * 100).toFixed(1)}% против базы ${(m.accBase * 100).toFixed(1)}%, ` +
      `t=${m.tPaired} при пороге леджера z≥${model.bonferroni ? model.bonferroni.zThreshold : '—'} — ` +
      (model.verdict === 'licensed' ? 'край доказан' : 'не значимо: скоса нет, мейкер котирует симметрично');
  }
}

// ---------- логин/старт ----------

function bindLogin() {
  $('loginBtn').addEventListener('click', async () => {
    try {
      await api('/login', { method: 'POST', body: JSON.stringify({ password: $('password').value }) });
      $('loginError').classList.add('hidden');
      showTerm();
    } catch (e) {
      $('loginError').textContent = e.message;
      $('loginError').classList.remove('hidden');
    }
  });
  $('password').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('loginBtn').click();
  });
}

async function boot() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
  bindLogin();
  try {
    const { authed, adminConfigured } = await api('/me');
    if (!adminConfigured) {
      $('login').classList.remove('hidden');
      $('loginError').textContent = 'ADMIN_PASSWORD не задан на сервере — экран выключен';
      $('loginError').classList.remove('hidden');
      return;
    }
    if (authed) showTerm();
    else showLogin();
  } catch {
    showLogin();
  }
}

boot();
