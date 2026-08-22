// Новостной фон, контур Б (решение владельца 22.08): LLM-прогнозы направления
// ФОРВАРДОМ. Идея владельца: «вышла новость → анализ → понимаем, куда тренд
// 12-96 часов → помогаем ботам». Честная рамка: прогноз фиксируется в БД С
// ТАЙМСТЕМПОМ ДО исхода, судья через 12/24/96ч сверяет с фактом. К торговле
// фон НЕ подключён и не подключится, пока не пройдёт гейт (правило
// зафиксировано 22.08 ДО данных): ≥30 прогнозов за окно наблюдения И
// направленная точность 12-24ч статистически бьёт монетку с порогом леджера.
//
// Механика: RSS-заголовки (CoinDesk / ForexLive / РБК) каждые 10 мин →
// дедуп по хэшу → LLM-скоринг батчем (строгий JSON: актив/направление/
// уверенность/горизонт; слабые связи отбрасываются) → строка news_Signal с
// ценой p0 на момент прогноза. Судья каждые 30 мин заполняет p12/p24/p96:
// BTC/ETH/EURUSD — колбэк живых цен (poly refPx / котировка движка),
// РФ-тикеры — минутки ISS ретроспективно (точно и бесплатно).
// Ошибки фидов/LLM не роняют ногу; без OPENAI_API_KEY скоринг молчит.

import { createHash } from 'node:crypto';
import { Agent, Dispatcher, ProxyAgent, request } from 'undici';
import { config } from '../config';
import { errMsg, log } from '../logger';

const FEEDS = [
  { source: 'coindesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
  { source: 'forexlive', url: 'https://www.forexlive.com/feed/' },
  { source: 'rbc', url: 'https://rssexport.rbc.ru/rbcnews/news/30/full.rss' },
];
// активы, которые умеем СУДИТЬ: BTC/ETH/EURUSD — живой колбэк, остальные — ISS
const CB_ASSETS = ['BTC', 'ETH', 'EURUSD'];
const RF_ASSETS = ['SBER', 'GAZP', 'LKOH', 'ROSN', 'NVTK', 'SIBN', 'TATN', 'AFKS', 'MOEX', 'ALRS', 'TRNFP', 'SVCB'];
const ASSETS = [...CB_ASSETS, ...RF_ASSETS];
const POLL_MS = 10 * 60_000;
const JUDGE_MS = 30 * 60_000;
const HORIZONS = [12, 24, 96] as const;
// колбэк-активы: допуск опоздания судьи (рестарт/даунтайм) — иначе честнее null
const CB_MAX_LAG_MS = 45 * 60_000;

const MSK_OFFSET_MS = 3 * 3600_000;
const ISS_BASE = 'https://iss.moex.com/iss/engines/stock/markets/shares/boards/TQBR/securities';

export interface NewsBiasDeps {
  getPrice: (asset: string) => number | null; // BTC/ETH/EURUSD (live), иначе null
}

interface HitStats {
  judged: number;
  hits: number;
}

export class NewsBiasLeg {
  private running = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private judgeTimer: NodeJS.Timeout | null = null;
  private seen = new Set<string>();
  private dayKey = '';
  private headlinesToday = 0;
  private scoredToday = 0;
  private llmErrToday = 0;
  private lastPollAt = 0;
  private pendingCount = 0;
  private hitStats: Record<number, HitStats> = { 12: { judged: 0, hits: 0 }, 24: { judged: 0, hits: 0 }, 96: { judged: 0, hits: 0 } };

  constructor(private deps: NewsBiasDeps) {}

  private dispatcher(): Dispatcher {
    const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
    return proxy ? new ProxyAgent(proxy) : new Agent();
  }

  private async prisma() {
    const { getPrisma } = await import('../db');
    return getPrisma();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    // первый цикл — через 45с после бута (не мешаем стартовой лавине)
    this.pollTimer = setInterval(() => void this.poll().catch(e => log.warn(`news poll: ${errMsg(e)}`, undefined, 'news')), POLL_MS);
    this.judgeTimer = setInterval(() => void this.judge().catch(e => log.warn(`news judge: ${errMsg(e)}`, undefined, 'news')), JUDGE_MS);
    setTimeout(() => void this.poll().catch(e => log.warn(`news poll: ${errMsg(e)}`, undefined, 'news')), 45_000);
    setTimeout(() => void this.judge().catch(e => log.warn(`news judge: ${errMsg(e)}`, undefined, 'news')), 90_000);
    log.success(`новостной фон запущен: ${FEEDS.length} фида / скоринг ${config.openaiKey ? config.openaiModel : 'ВЫКЛ (нет OPENAI_API_KEY)'} / судья 12-24-96ч`, undefined, 'news');
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.judgeTimer) clearInterval(this.judgeTimer);
    this.pollTimer = this.judgeTimer = null;
  }

  private rollDay(): void {
    const k = new Date().toISOString().slice(0, 10);
    if (k !== this.dayKey) {
      this.dayKey = k;
      this.headlinesToday = 0;
      this.scoredToday = 0;
      this.llmErrToday = 0;
    }
  }

  // ---------- сбор и скоринг ----------

  private async fetchFeed(url: string): Promise<Array<{ title: string; pub: number | null }>> {
    let res = await request(url, {
      dispatcher: this.dispatcher(),
      headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) fx-agent-news/1.0', accept: 'application/rss+xml, application/xml, text/xml' },
      headersTimeout: 15_000,
      bodyTimeout: 20_000,
    });
    // одноходовой редирект (forexlive отдаёт 301 на канонический URL)
    if ([301, 302, 307, 308].includes(res.statusCode)) {
      const loc = res.headers.location;
      const next = Array.isArray(loc) ? loc[0] : loc;
      await res.body.text().catch(() => '');
      if (!next) throw new Error(`HTTP ${res.statusCode} без location`);
      res = await request(new URL(next, url).toString(), {
        dispatcher: this.dispatcher(),
        headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) fx-agent-news/1.0', accept: 'application/rss+xml, application/xml, text/xml' },
        headersTimeout: 15_000,
        bodyTimeout: 20_000,
      });
    }
    const text = await res.body.text();
    if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}`);
    const items: Array<{ title: string; pub: number | null }> = [];
    for (const m of text.matchAll(/<item[\s>]([\s\S]*?)<\/item>/g)) {
      const chunk = m[1];
      const t = /<title>(?:\s*<!\[CDATA\[)?([\s\S]*?)(?:\]\]>\s*)?<\/title>/.exec(chunk)?.[1]?.trim();
      if (!t) continue;
      const pd = /<pubDate>([\s\S]*?)<\/pubDate>/.exec(chunk)?.[1]?.trim();
      const pub = pd ? Date.parse(pd) : NaN;
      items.push({ title: t.replace(/\s+/g, ' ').slice(0, 300), pub: Number.isFinite(pub) ? pub : null });
      if (items.length >= 30) break;
    }
    return items;
  }

  private async poll(): Promise<void> {
    if (!this.running) return;
    this.rollDay();
    this.lastPollAt = Date.now();
    const fresh: Array<{ source: string; title: string; hash: string }> = [];
    for (const f of FEEDS) {
      try {
        const items = await this.fetchFeed(f.url);
        for (const it of items) {
          if (it.pub !== null && Date.now() - it.pub > 12 * 3600_000) continue; // старьё
          const hash = createHash('sha1').update(`${f.source}|${it.title}`).digest('hex');
          if (this.seen.has(hash)) continue;
          this.seen.add(hash);
          fresh.push({ source: f.source, title: it.title, hash });
        }
      } catch (e) {
        log.warn(`news feed ${f.source}: ${errMsg(e)}`, undefined, 'news');
      }
    }
    if (this.seen.size > 4000) this.seen = new Set([...this.seen].slice(-2000));
    if (!fresh.length) return;
    // дедуп против БД (рестарты): уникальность (hash, asset) добьёт остальное
    try {
      const p = await this.prisma();
      const known = await p.newsSignal.findMany({ where: { hash: { in: fresh.map(x => x.hash) } }, select: { hash: true } });
      const knownSet = new Set(known.map((k: { hash: string }) => k.hash));
      const toScore = fresh.filter(x => !knownSet.has(x.hash));
      this.headlinesToday += toScore.length;
      if (!toScore.length) return;
      for (let i = 0; i < toScore.length; i += 12) {
        await this.scoreBatch(toScore.slice(i, i + 12));
      }
    } catch (e) {
      log.warn(`news score: ${errMsg(e)}`, undefined, 'news');
    }
  }

  private async scoreBatch(batch: Array<{ source: string; title: string; hash: string }>): Promise<void> {
    if (!config.openaiKey || !batch.length) return;
    let parsed: Array<{ i: number; asset: string; dir: number; conf: number; horizonH: number; reason?: string }> = [];
    try {
      const res = await request('https://api.openai.com/v1/chat/completions', {
        dispatcher: this.dispatcher(),
        method: 'POST',
        headers: { authorization: `Bearer ${config.openaiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: config.openaiModel,
          max_tokens: 900,
          temperature: 0.2,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content: 'Ты аналитик новостного фона алго-системы. Для каждого заголовка реши, задаёт ли он '
                + `НАПРАВЛЕННЫЙ тренд на 12-96 часов ровно для этих активов: ${ASSETS.join(', ')}. `
                + 'BTC/ETH — крипта; EURUSD — евро-доллар; остальное — тикеры Мосбиржи. Верни СТРОГО JSON: '
                + '{"signals":[{"i":<индекс заголовка>,"asset":"BTC","dir":1|-1,"conf":0.5..1,"horizonH":12|24|96,"reason":"кратко"}]}. '
                + 'Включай ТОЛЬКО сильные однозначные связи (важная новость, ясное направление), максимум 2 актива на заголовок. '
                + 'Рутинные/неоднозначные заголовки пропускай молча. Нет сигналов — {"signals":[]}.',
            },
            { role: 'user', content: batch.map((b, i) => `${i}. [${b.source}] ${b.title}`).join('\n') },
          ],
        }),
        headersTimeout: 20_000,
        bodyTimeout: 60_000,
      });
      const text = await res.body.text();
      if (res.statusCode >= 300) throw new Error(`OpenAI ${res.statusCode}: ${text.slice(0, 160)}`);
      const content = JSON.parse(text).choices?.[0]?.message?.content ?? '{}';
      parsed = JSON.parse(content).signals ?? [];
    } catch (e) {
      this.llmErrToday += 1;
      log.warn(`news llm: ${errMsg(e)}`, undefined, 'news');
      return;
    }
    const rows: Array<{ source: string; title: string; hash: string; asset: string; dir: number; conf: number; horizonH: number; reason: string | null; p0: number | null }> = [];
    for (const s of parsed) {
      const b = batch[s.i];
      if (!b || !ASSETS.includes(s.asset) || ![1, -1].includes(s.dir) || !(s.conf >= 0.5)) continue;
      const horizonH = HORIZONS.includes(s.horizonH as 12 | 24 | 96) ? s.horizonH : 24;
      rows.push({
        source: b.source, title: b.title, hash: b.hash, asset: s.asset, dir: s.dir,
        conf: Math.min(1, s.conf), horizonH, reason: (s.reason ?? '').slice(0, 200) || null,
        p0: await this.priceNow(s.asset),
      });
    }
    if (!rows.length) return;
    const p = await this.prisma();
    await p.newsSignal.createMany({ data: rows, skipDuplicates: true });
    this.scoredToday += rows.length;
    log.info(`новостной фон: +${rows.length} прогнозов (${rows.map(r => `${r.asset}${r.dir > 0 ? '↑' : '↓'}`).join(' ')})`, undefined, 'news');
  }

  // ---------- цены ----------

  private async priceNow(asset: string): Promise<number | null> {
    if (CB_ASSETS.includes(asset)) return this.deps.getPrice(asset);
    return this.issCloseAt(asset, Date.now()).catch(() => null);
  }

  /** Последний минутный close ISS ≤ момента t (поиск от дня t назад до 5 дней). */
  private async issCloseAt(ticker: string, t: number): Promise<number | null> {
    for (let back = 0; back < 5; back++) {
      const day = new Date(t - back * 86400_000).toISOString().slice(0, 10);
      let best: number | null = null;
      for (let start = 0; ; start += 500) {
        const url = `${ISS_BASE}/${ticker}/candles.json?interval=1&from=${day}&till=${day}&start=${start}`;
        // ISS ходим напрямую, как moex-data.ts (через прокси-агент соединение рвётся)
        const res = await request(url, { headersTimeout: 15_000, bodyTimeout: 20_000 });
        const text = await res.body.text();
        if (res.statusCode !== 200) throw new Error(`ISS ${ticker}: HTTP ${res.statusCode}`);
        const j = JSON.parse(text);
        const cols: string[] = j.candles.columns;
        const iC = cols.indexOf('close');
        const iBegin = cols.indexOf('begin');
        const data: any[][] = j.candles.data;
        for (const r of data) {
          const ts = new Date(String(r[iBegin]).replace(' ', 'T') + 'Z').getTime() - MSK_OFFSET_MS;
          if (ts <= t) best = r[iC];
        }
        if (data.length < 500) break;
      }
      if (best !== null) return best;
    }
    return null;
  }

  // ---------- судья ----------

  private async judge(): Promise<void> {
    if (!this.running) return;
    const p = await this.prisma();
    const now = Date.now();
    for (const h of HORIZONS) {
      const field = `p${h}` as 'p12' | 'p24' | 'p96';
      const due = await p.newsSignal.findMany({
        where: { [field]: null, ts: { lte: new Date(now - h * 3600_000) } },
        orderBy: { ts: 'asc' },
        take: 20,
      });
      for (const row of due) {
        const deadline = row.ts.getTime() + h * 3600_000;
        let px: number | null = null;
        if (CB_ASSETS.includes(row.asset)) {
          // живой колбэк: судим только в окне допуска; протухшее (>7д) закрываем NaN-маркером −1? нет: честный null навсегда
          if (now - deadline <= CB_MAX_LAG_MS) px = this.deps.getPrice(row.asset);
          else if (now - deadline > 7 * 86400_000) px = row.p0; // окно упущено навсегда → нейтрализуем (hit не засчитается)
        } else {
          px = await this.issCloseAt(row.asset, deadline).catch(() => null);
        }
        if (px !== null) await p.newsSignal.update({ where: { id: row.id }, data: { [field]: px } });
      }
    }
    // сводка точности (для /health): все судимые строки с p0
    const judged = await p.newsSignal.findMany({ where: { p0: { not: null } }, select: { dir: true, p0: true, p12: true, p24: true, p96: true } });
    const st: Record<number, HitStats> = { 12: { judged: 0, hits: 0 }, 24: { judged: 0, hits: 0 }, 96: { judged: 0, hits: 0 } };
    for (const r of judged) {
      for (const h of HORIZONS) {
        const px = r[`p${h}` as 'p12'];
        if (px === null || r.p0 === null || px === r.p0) continue;
        st[h].judged += 1;
        if (Math.sign(px - r.p0) === Math.sign(r.dir)) st[h].hits += 1;
      }
    }
    this.hitStats = st;
    this.pendingCount = await p.newsSignal.count({ where: { OR: HORIZONS.map(h => ({ [`p${h}`]: null })) } });
  }

  summarySync() {
    const hs = this.hitStats;
    const acc = (h: number) => (hs[h].judged ? +(hs[h].hits / hs[h].judged * 100).toFixed(1) : null);
    return {
      running: this.running,
      scoring: Boolean(config.openaiKey),
      lastPollAgoSec: this.lastPollAt ? Math.round((Date.now() - this.lastPollAt) / 1000) : null,
      headlinesToday: this.headlinesToday,
      scoredToday: this.scoredToday,
      llmErrToday: this.llmErrToday,
      pending: this.pendingCount,
      acc12: acc(12), n12: hs[12].judged,
      acc24: acc(24), n24: hs[24].judged,
      acc96: acc(96), n96: hs[96].judged,
    };
  }
}
