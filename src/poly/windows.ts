// Анализ окон сет-арбитража и статистики исходов (план M4, гейт этапа 1).
// Входы: экспорт снапов прод-БД (JSON-файл; DATABASE_URL локально нет —
// выгрузка через Supabase MCP отдельным шагом) + история резолюций из
// data/poly-history/<asset>.jsonl (харвестер).
//
// ГЕЙТ (сформулирован до сбора данных, план 17.08): окна setSumAsk<0.99 реже
// 1/день ИЛИ медианная глубина окон <$20 → торговлю (M6) хороним. Пока снапов
// меньше 3-5 суток — вердикт помечается ПРЕДВАРИТЕЛЬНЫМ, наблюдение копится.
//
// Запуск: npx tsx src/poly/windows.ts --snaps <export.json> --out <report.md>

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadHist } from './harvest';

interface SnapRow {
  ts: string;
  asset: string;
  setSumAsk: number | null;
  upBid: number | null;
  upAsk: number | null;
  downBid: number | null;
  downAsk: number | null;
  depthUsd: number | null;
  isEvent: boolean;
}

interface Episode {
  asset: string;
  fromMs: number;
  toMs: number;
  minSum: number;
  medDepth: number;
  snaps: number;
}

function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** Эпизоды sum<threshold: соседние подходящие снапы склеиваются при разрыве ≤120с. */
export function episodes(snaps: SnapRow[], threshold: number): Episode[] {
  const out: Episode[] = [];
  const byAsset = new Map<string, SnapRow[]>();
  for (const s of snaps) {
    if (s.setSumAsk === null) continue;
    if (!byAsset.has(s.asset)) byAsset.set(s.asset, []);
    byAsset.get(s.asset)!.push(s);
  }
  for (const [asset, rows] of byAsset) {
    rows.sort((a, b) => a.ts.localeCompare(b.ts));
    let cur: { from: number; to: number; sums: number[]; depths: number[] } | null = null;
    const flush = () => {
      if (!cur) return;
      out.push({
        asset, fromMs: cur.from, toMs: cur.to,
        minSum: Math.min(...cur.sums),
        medDepth: median(cur.depths),
        snaps: cur.sums.length,
      });
      cur = null;
    };
    for (const s of rows) {
      const t = new Date(s.ts).getTime();
      if ((s.setSumAsk as number) < threshold) {
        if (cur && t - cur.to <= 120_000) {
          cur.to = t;
          cur.sums.push(s.setSumAsk as number);
          if (s.depthUsd !== null) cur.depths.push(s.depthUsd);
        } else {
          flush();
          cur = { from: t, to: t, sums: [s.setSumAsk as number], depths: s.depthUsd !== null ? [s.depthUsd] : [] };
        }
      }
    }
    flush();
  }
  return out.sort((a, b) => a.fromMs - b.fromMs);
}

function fmtEp(e: Episode): string {
  const dur = Math.max(1, Math.round((e.toMs - e.fromMs) / 1000));
  return `${e.asset} ${new Date(e.fromMs).toISOString().slice(5, 16)}Z · ${dur}с · min $${e.minSum.toFixed(3)} · глубина ~$${isNaN(e.medDepth) ? '—' : e.medDepth.toFixed(0)} · снапов ${e.snaps}`;
}

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const snapsFile = arg('snaps', 'data/poly-history/snaps-export.json');
  const outFile = arg('out', `docs/POLY-WINDOWS-${new Date().toISOString().slice(0, 10)}.md`);
  const snaps = JSON.parse(readFileSync(snapsFile, 'utf8')) as SnapRow[];

  const tsList = snaps.map(s => new Date(s.ts).getTime());
  const spanH = (Math.max(...tsList) - Math.min(...tsList)) / 3600_000;
  const spanDays = spanH / 24;

  const ep99 = episodes(snaps, 0.99);
  const ep1005 = episodes(snaps, 1.005);

  // спреды сторон — где обе котировки живые
  const upSpreads = snaps.filter(s => s.upAsk !== null && s.upBid !== null).map(s => (s.upAsk as number) - (s.upBid as number));
  const dnSpreads = snaps.filter(s => s.downAsk !== null && s.downBid !== null).map(s => (s.downAsk as number) - (s.downBid as number));

  // исходы истории: btc (+eth если есть)
  const lines: string[] = [];
  lines.push(`# Polymarket 5m — окна и исходы (${new Date().toISOString().slice(0, 16)}Z)`);
  lines.push('');
  lines.push(`Снапов в выборке: **${snaps.length}** за **${spanH.toFixed(1)}ч** (${[...new Set(snaps.map(s => s.asset))].join(', ')}). ` +
    (spanDays < 3 ? '⚠️ Меньше 3 суток — все вердикты ПРЕДВАРИТЕЛЬНЫЕ.' : ''));
  lines.push('');
  lines.push('## Окна сет-арбитража (эпизоды, разрыв склейки ≤120с)');
  lines.push('');
  lines.push(`| порог | эпизодов | эп./день | медианная длительность | медианная глубина | min sum |`);
  lines.push(`|---|---|---|---|---|---|`);
  for (const [th, eps] of [[0.99, ep99], [1.005, ep1005]] as const) {
    const durs = eps.map(e => Math.max(1, (e.toMs - e.fromMs) / 1000));
    const depths = eps.map(e => e.medDepth).filter(d => !isNaN(d));
    lines.push(`| <$${th} | ${eps.length} | ${(eps.length / Math.max(spanDays, 1 / 24)).toFixed(1)} | ${eps.length ? Math.round(median(durs)) + 'с' : '—'} | ${depths.length ? '$' + median(depths).toFixed(0) : '—'} | ${eps.length ? '$' + Math.min(...eps.map(e => e.minSum)).toFixed(3) : '—'} |`);
  }
  lines.push('');
  if (ep99.length) {
    lines.push('Эпизоды <$0.99:');
    for (const e of ep99.slice(-20)) lines.push(`- ${fmtEp(e)}`);
    lines.push('');
  }
  lines.push(`Спреды сторон (медианы): UP ${upSpreads.length ? r3(median(upSpreads)) : '—'} · DOWN ${dnSpreads.length ? r3(median(dnSpreads)) : '—'} ` +
    `(по ${upSpreads.length}/${dnSpreads.length} снапов с двусторонней книгой).`);
  lines.push('');

  lines.push('## Исходы (история харвестера)');
  lines.push('');
  for (const asset of ['btc', 'eth']) {
    const hist = [...loadHist(asset).values()].filter(h => !h.missing && h.outcome).sort((a, b) => a.ts - b.ts);
    if (!hist.length) {
      lines.push(`- ${asset}: истории нет (харвест не запускался)`);
      continue;
    }
    const ups = hist.filter(h => h.outcome === 'up').length;
    // автокорреляция соседних бакетов — заготовка фич M5
    let uu = 0, un = 0, du = 0, dn = 0;
    for (let i = 1; i < hist.length; i++) {
      if (hist[i - 1].ts + 300 !== hist[i].ts) continue; // только смежные
      const prevUp = hist[i - 1].outcome === 'up';
      const curUp = hist[i].outcome === 'up';
      if (prevUp) { curUp ? uu++ : un++; } else { curUp ? du++ : dn++; }
    }
    let maxStreak = 0, cur = 0;
    let prev: string | undefined;
    for (const h of hist) {
      cur = h.outcome === prev ? cur + 1 : 1;
      prev = h.outcome;
      maxStreak = Math.max(maxStreak, cur);
    }
    const days = (hist[hist.length - 1].ts - hist[0].ts) / 86400;
    lines.push(`- **${asset}**: ${hist.length} исходов за ${days.toFixed(1)} дн · UP ${(ups / hist.length * 100).toFixed(1)}% · ` +
      `P(up|prev up) ${(uu + un) ? (uu / (uu + un) * 100).toFixed(1) : '—'}% vs P(up|prev down) ${(du + dn) ? (du / (du + dn) * 100).toFixed(1) : '—'}% · макс стрик ${maxStreak}`);
  }
  lines.push('');

  const winPerDay = ep99.length / Math.max(spanDays, 1 / 24);
  const depths99 = ep99.map(e => e.medDepth).filter(d => !isNaN(d));
  const medDepth99 = depths99.length ? median(depths99) : 0;
  const gatePass = winPerDay >= 1 && medDepth99 >= 20;
  lines.push('## Гейт этапа 1 (правило зафиксировано в плане 17.08 до сбора данных)');
  lines.push('');
  lines.push(`Окна <$0.99: **${winPerDay.toFixed(1)}/день** (нужно ≥1) · медианная глубина: **${depths99.length ? '$' + medDepth99.toFixed(0) : 'нет данных'}** (нужно ≥$20).`);
  lines.push('');
  lines.push(spanDays < 3
    ? `Вердикт: **ПРЕДВАРИТЕЛЬНО ${gatePass ? 'ПРОХОДИТ' : 'НЕ ПРОХОДИТ'}** — снапов ${spanH.toFixed(0)}ч, гейт закрывается после ≥3-5 суток наблюдения.`
    : `Вердикт: **${gatePass ? 'ПРОХОДИТ — M6 (бумажный мейкер) получает зелёный свет' : 'НЕ ПРОХОДИТ — торговую часть хороним, остаются коллектор+дашборд+модель'}**.`);
  lines.push('');

  const report = lines.join('\n');
  writeFileSync(outFile, report);
  console.log(report);
  console.log(`\n→ ${outFile}`);
}
