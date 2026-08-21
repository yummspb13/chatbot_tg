// Виртуальная MOEX-нога (РФ-ветка, docs/RF-BROKER-PLAN.md, шаг 2).
//
// Читает верх стакана T-Invest API (read-only токен) по победителям
// офлайн-разведок (docs/MOEX-2026-08-03.md — первая тройка;
// docs/MOEX-FULL-2026-08-05.md — расширение после валидации живыми спредами)
// и кормит виртуальные книги EnsembleLeg — та же механика, что у остальных
// ансамблей, плюс ЧЕСТНАЯ комиссия РФ-брокера: 0.1% нотионала за круг
// вычитается из pnl каждой виртуальной сделки (commissionFrac). Деньги не
// затрагиваются вообще — торговых вызовов в клиенте нет.
//
// Сессии MOEX (MSK без переходов → UTC константно): основная 06:50-15:40,
// вечерняя 16:05-20:50, будни. Вне сессий нога спит (котировок нет, лимит
// запросов не тратим). Опрос стакана раз в 5с × 11 инструментов ≈ 132 req/мин
// при розничном лимите ~300.

import { config } from '../config';
import { errMsg, log } from '../logger';
import { AgentParams, DEFAULT_PARAMS, EnsembleMember } from './params';
import { EnsembleDeps, EnsembleLeg } from './ensemble';
import { TickerMirror } from './afksmirror';
import { MOEX_INSTRUMENTS, TinkoffClient } from '../broker/tinkoff';
import { sleep } from '../broker/types';

interface MoexSpec {
  ticker: string;      // = baseSymbol виртуальных сделок (TATN~tatn-meanrev)
  priceScale: number;
  roster: EnsembleMember[];
}

const moexParams = (over: Partial<AgentParams>): AgentParams => ({
  ...DEFAULT_PARAMS,
  newsBufferMin: 0, // ФФ-календарь (США/ЕС) к Мосбирже не применяем
  ...over,
} as AgentParams);

// Параметры = победившие ячейки разведки 03.08 (после комиссий 0.1%/круг)
export const MOEX_LEGS: MoexSpec[] = [
  {
    ticker: 'TATN', priceScale: 1000,
    roster: [{
      key: 'tatn-meanrev', // звезда разведки: train +17.9 / test +33.2 net, wr 67%
      params: moexParams({ windowSec: 3600, thresholdPips: 144, tpPips: 90, slPips: 180, cooldownSec: 900, spreadGuardPips: 8, maxDailyLossUsd: 15 }),
    }],
  },
  {
    ticker: 'GAZP', priceScale: 1000,
    roster: [{
      key: 'gazp-meanrev', // 4 согласованные ячейки; берём w3600-версию
      params: moexParams({ windowSec: 3600, thresholdPips: 32, tpPips: 40, slPips: 80, cooldownSec: 900, spreadGuardPips: 3, maxDailyLossUsd: 10 }),
    }],
  },
  {
    ticker: 'ROSN', priceScale: 1000,
    roster: [{
      key: 'rosn-impulse', // сырьевая подпись impulse: третий класс активов
      params: moexParams({ strategyType: 'impulse', windowSec: 3600, thresholdPips: 12, tpPips: 60, slPips: 120, cooldownSec: 900, spreadGuardPips: 6, maxDailyLossUsd: 10 }),
    }],
  },
  // ---- Расширение 05.08 (по команде «подключай»): полный скан 36 бумаг +
  // валидация живыми стаканами. AFKS/MOEX/TRNFP — спред-модель подтверждена
  // честной (×0.9-1.2); SVCB/SNGS/RAGR/SIBN/ALRS — ячейки пересчитаны с
  // РЕАЛЬНЫМИ спредами и выжили. Параметры = лучшие walk-forward-ячейки.
  {
    ticker: 'AFKS', priceScale: 10,
    roster: [{
      key: 'afks-matrend', // 14 проходов скана; лучшая: train +21.9 / test +30.3 (40 сд, wr 65%)
      params: moexParams({ strategyType: 'matrend', windowSec: 7200, thresholdPips: 24, tpPips: 60, slPips: 120, cooldownSec: 1800, spreadGuardPips: 6, maxDailyLossUsd: 15 }),
    }],
  },
  {
    ticker: 'MOEX', priceScale: 1000,
    roster: [{
      key: 'moex-meanrev', // 9 проходов; w3600: train +40.7 / test +13 (77 сд, wr 61%)
      params: moexParams({ strategyType: 'meanrev', entryMode: 'market', windowSec: 3600, thresholdPips: 32, tpPips: 40, slPips: 80, cooldownSec: 900, spreadGuardPips: 2, maxDailyLossUsd: 10 }),
    }],
  },
  {
    ticker: 'TRNFP', priceScale: 10_000,
    roster: [{
      key: 'trnfp-meanrev', // 6 проходов; train +5.4 / test +31.6 (226 сд, wr 70%)
      params: moexParams({ strategyType: 'meanrev', windowSec: 3600, thresholdPips: 16, tpPips: 10, slPips: 20, cooldownSec: 900, spreadGuardPips: 1.5, maxDailyLossUsd: 10 }),
    }],
  },
  {
    ticker: 'SVCB', priceScale: 100,
    roster: [{
      key: 'svcb-meanrev', // с реальным спредом ×2.4: train +34 / test +22.1 (41 сд, wr 71%)
      params: moexParams({ strategyType: 'meanrev', windowSec: 1800, thresholdPips: 32, tpPips: 40, slPips: 80, cooldownSec: 900, spreadGuardPips: 2, maxDailyLossUsd: 10 }),
    }],
  },
  {
    ticker: 'SNGS', priceScale: 100,
    roster: [{
      key: 'sngs-meanrev', // с реальным спредом ×1.6: train +24.5 / test +22.1 (78 сд, wr 71%)
      params: moexParams({ strategyType: 'meanrev', windowSec: 3600, thresholdPips: 48, tpPips: 30, slPips: 60, cooldownSec: 900, spreadGuardPips: 3, maxDailyLossUsd: 10 }),
    }],
  },
  {
    ticker: 'RAGR', priceScale: 1000,
    roster: [{
      key: 'ragr-meanrev', // с реальным спредом ×2.0: train +10.1 / test +13.6 (78 сд, wr 68%)
      params: moexParams({ strategyType: 'meanrev', windowSec: 3600, thresholdPips: 32, tpPips: 40, slPips: 80, cooldownSec: 900, spreadGuardPips: 3, maxDailyLossUsd: 10 }),
    }],
  },
  {
    ticker: 'SIBN', priceScale: 1000,
    roster: [{
      key: 'sibn-meanrev', // с реальным спредом ×1.6: train +84.5 / test +49.4 (316 сд, wr 63%)
      params: moexParams({ strategyType: 'meanrev', windowSec: 3600, thresholdPips: 56, tpPips: 70, slPips: 140, cooldownSec: 900, spreadGuardPips: 8, maxDailyLossUsd: 15 }),
    }],
  },
  {
    ticker: 'ALRS', priceScale: 100,
    roster: [{
      key: 'alrs-meanrev', // с реальным спредом ×2.2: train +16.2 / test +56.2 (48 сд, wr 67%)
      params: moexParams({ strategyType: 'meanrev', entryMode: 'market', windowSec: 3600, thresholdPips: 112, tpPips: 70, slPips: 140, cooldownSec: 900, spreadGuardPips: 9, maxDailyLossUsd: 15 }),
    }],
  },
];

// Медианные спреды живых стаканов (замер 05.08, data/moex-spread-check.json) —
// доля цены; используются ТОЛЬКО догонкой простоя (у ISS-минуток спреда нет)
const MEDIAN_SPREAD_FRAC: Record<string, number> = {
  TATN: 0.00019, GAZP: 0.00011, ROSN: 0.00014, AFKS: 0.00021, MOEX: 0.00025,
  TRNFP: 0.00018, SVCB: 0.00048, SNGS: 0.00032, RAGR: 0.0004, SIBN: 0.00032, ALRS: 0.00044,
};

/** Будни, основная или вечерняя сессия Мосбиржи (UTC; MSK без DST). */
export function moexInSession(now: Date): boolean {
  const dow = now.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  return (mins >= 6 * 60 + 50 && mins <= 15 * 60 + 40) || (mins >= 16 * 60 + 5 && mins <= 20 * 60 + 50);
}

export class MoexLeg {
  private legs: Array<{ spec: MoexSpec; leg: EnsembleLeg; uid: string }> = [];
  private client: TinkoffClient | null = null;
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private lastQuoteAt = 0;
  private mirrors: TickerMirror[] = [];

  constructor(
    private deps: EnsembleDeps & { notify: (text: string) => Promise<void> },
    private specs: MoexSpec[] = MOEX_LEGS,
  ) {}

  isRunning(): boolean {
    return this.running;
  }

  async start(gapStart?: Date | null): Promise<void> {
    if (this.running) return;
    if (!config.tinkoffToken) throw new Error('MOEX-нога требует TINKOFF_TOKEN (read-only) в env');
    this.client = new TinkoffClient(config.tinkoffToken);
    // uid: статическая карта → иначе ShareBy (тикер без uid пропускается с
    // предупреждением, не роняя остальные — урок SPBE, которого нет в T-Invest)
    this.legs = [];
    for (const spec of this.specs) {
      let uid = MOEX_INSTRUMENTS[spec.ticker]?.uid ?? null;
      if (!uid) {
        try {
          uid = await this.client.shareUid(spec.ticker);
        } catch (e) {
          log.warn(`MOEX ${spec.ticker}: uid не найден (${errMsg(e)}) — тикер пропущен`, undefined, 'moex');
          continue;
        }
      }
      this.legs.push({
        spec,
        uid,
        leg: new EnsembleLeg(
          this.deps,
          { baseSymbol: spec.ticker, crypto: false, warmup: null, commissionFrac: 0.001 },
          spec.roster,
        ),
      });
    }
    for (const l of this.legs) await l.leg.start();
    this.running = true;

    // Micro-этап (решение владельца 18.08, мультитикер 21.08): зеркала живых
    // сделок лицензированных виртуалов реальными ордерами (env MIRRORS). Ошибка
    // зеркала НЕ роняет ногу, а сетевой чих на буте НЕ хоронит этап: подписка
    // ставится сразу (события фильтрует running), старт ретраится каждые 5 мин.
    if (config.afksLive !== 'off') {
      for (const mc of config.mirrors) {
        const legEntry = this.legs.find(l => l.spec.ticker === mc.ticker);
        if (!legEntry) {
          log.warn(`зеркало ${mc.ticker}: тикера нет в ноге — пропуск`, undefined, 'afks');
          continue;
        }
        if (!legEntry.spec.roster.some(r => r.key === mc.memberKey)) {
          log.warn(`зеркало ${mc.ticker}: виртуал ${mc.memberKey} не в ростере — пропуск`, undefined, 'afks');
          continue;
        }
        const mirror = new TickerMirror({ notify: this.deps.notify }, mc);
        this.mirrors.push(mirror);
        const scale = legEntry.spec.priceScale;
        legEntry.leg.onVirtualTrade(e => {
          if (e.memberKey !== mc.memberKey) return;
          mirror.onVirtual({
            ...e,
            priceRub: e.price * scale,
            tpRub: e.tp === undefined ? undefined : e.tp * scale,
            slRub: e.sl === undefined ? undefined : e.sl * scale,
          });
        });
        void this.startMirrorWithRetry(mirror, mc.ticker);
      }
    }

    if (gapStart) await this.replayGap(gapStart);
    this.loopPromise = this.loop();
    log.success(
      `MOEX-нога запущена: ${this.legs.map(l => `${l.spec.ticker} (${l.spec.roster.map(r => r.key).join('+')})`).join(', ')} — виртуально, read-only, комиссия 0.1%/круг в модели`,
      undefined, 'moex',
    );
  }

  /** Старт зеркала с ретраями: боевой/песочный контур Тинькофф из-за границы
   *  иногда таймаутится на хэндшейке — пробуем, пока нога жива. */
  private async startMirrorWithRetry(mirror: TickerMirror, ticker: string): Promise<void> {
    for (let attempt = 0; this.running && !mirror.isRunning(); attempt++) {
      try {
        await mirror.start();
        mirror.startError = null;
        if (attempt > 0) await this.deps.notify(`✅ ${ticker}-зеркало поднялось после ретрая.`).catch(() => {});
        return;
      } catch (e) {
        mirror.startError = errMsg(e); // диагноз виден в /health без пароля
        log.error(`${ticker}-зеркало: старт не удался (попытка ${attempt + 1}): ${mirror.startError}`, undefined, 'afks');
        if (attempt === 0) {
          await this.deps.notify(`⚠️ ${ticker}-зеркало не запустилось: ${mirror.startError} — ретраю каждые 5 минут.`).catch(() => {});
        }
        await sleep(300_000);
      }
    }
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.loopPromise) {
      await this.loopPromise.catch(() => {});
      this.loopPromise = null;
    }
    for (const m of this.mirrors) await m.stop().catch(() => {});
    this.mirrors = [];
    await this.client?.shutdown().catch(() => {});
    this.client = null;
    for (const l of this.legs) l.leg.stop();
    log.info('MOEX-нога остановлена', undefined, 'moex');
  }

  /** Догонка простоя: ISS-минутки за [gapStart, сейчас] проигрываются через
   *  полный торговый путь книг (сделки-BF). Спред — медиана живого замера. */
  private async replayGap(gapStart: Date): Promise<void> {
    const from = new Date(Math.max(gapStart.getTime(), Date.now() - 72 * 3600_000));
    for (const l of this.legs) {
      try {
        const { loadMoexM1 } = await import('../backtest/moex-data');
        const frac = MEDIAN_SPREAD_FRAC[l.spec.ticker] ?? 0.0002;
        const candles = (await loadMoexM1(l.spec.ticker, from, new Date()))
          .filter(c => c.t >= from.getTime())
          .map(c => ({ ...c, sp: c.c * frac }));
        await l.leg.replayCandles(candles, l.spec.priceScale, from);
      } catch (e) {
        log.warn(`MOEX догонка ${l.spec.ticker}: ${errMsg(e)} — пропуск останется дырой`, undefined, 'moex');
      }
    }
  }

  private async loop(): Promise<void> {
    let errStreak = 0;
    while (this.running) {
      if (!moexInSession(new Date())) {
        await sleep(60_000);
        continue;
      }
      for (const l of this.legs) {
        if (!this.running) break;
        try {
          if (!this.client) continue;
          const top = await this.client.orderBookTop(l.uid);
          if (top.bid === null || top.ask === null || top.ask <= top.bid) continue; // аукцион/пусто
          this.lastQuoteAt = Date.now();
          await l.leg.onQuote({
            symbol: l.spec.ticker,
            bid: top.bid / l.spec.priceScale,
            ask: top.ask / l.spec.priceScale,
            time: new Date(),
          });
          errStreak = 0;
        } catch (e) {
          errStreak += 1;
          if (errStreak % 20 === 1) log.warn(`MOEX ${l.spec.ticker}: ${errMsg(e)}`, undefined, 'moex');
        }
      }
      await sleep(5_000);
    }
  }

  /** Сводка в форме EnsembleLeg.stats() — участники всех тикеров одним списком. */
  async stats(): Promise<{
    running: boolean;
    lastQuoteAgoSec: number | null;
    members: Awaited<ReturnType<EnsembleLeg['stats']>>['members'];
  }> {
    const all = await Promise.all(this.legs.map(l => l.leg.stats()));
    const ages = all.map(s => s.lastQuoteAgoSec).filter((x): x is number => typeof x === 'number');
    return {
      running: this.running,
      lastQuoteAgoSec: ages.length ? Math.min(...ages) : null,
      members: all.flatMap(s => s.members),
    };
  }

  summary() {
    return {
      enabled: true,
      running: this.running,
      inSession: moexInSession(new Date()),
      tickers: (this.legs.length ? this.legs.map(l => l.spec) : this.specs).map(s => s.ticker),
      lastQuoteAgoSec: this.lastQuoteAt ? Math.round((Date.now() - this.lastQuoteAt) / 1000) : null,
      mirrors: this.mirrors.map(m => m.summary()),
      // алиас для мониторинга/детекторов, писанных под одно AFKS-зеркало
      afksMirror: this.mirrors.find(m => m.summary().ticker === 'AFKS')?.summary()
        ?? { mode: config.afksLive, running: false, startError: null },
    };
  }
}
