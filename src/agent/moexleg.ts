// Виртуальная MOEX-нога (РФ-ветка, docs/RF-BROKER-PLAN.md, шаг 2).
//
// Читает верх стакана T-Invest API (read-only токен) по трём победителям
// офлайн-разведки (docs/MOEX-2026-08-03.md) и кормит виртуальные книги
// EnsembleLeg — та же механика, что у остальных ансамблей, плюс ЧЕСТНАЯ
// комиссия РФ-брокера: 0.1% нотионала за круг вычитается из pnl каждой
// виртуальной сделки (commissionFrac). Деньги не затрагиваются вообще —
// торговых вызовов в клиенте нет.
//
// Сессии MOEX (MSK без переходов → UTC константно): основная 06:50-15:40,
// вечерняя 16:05-20:50, будни. Вне сессий нога спит (котировок нет, лимит
// запросов не тратим). Опрос стакана раз в 5с × 3 инструмента = 36 req/мин
// при розничном лимите ~300.

import { config } from '../config';
import { errMsg, log } from '../logger';
import { AgentParams, DEFAULT_PARAMS, EnsembleMember } from './params';
import { EnsembleDeps, EnsembleLeg } from './ensemble';
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
];

/** Будни, основная или вечерняя сессия Мосбиржи (UTC; MSK без DST). */
export function moexInSession(now: Date): boolean {
  const dow = now.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  return (mins >= 6 * 60 + 50 && mins <= 15 * 60 + 40) || (mins >= 16 * 60 + 5 && mins <= 20 * 60 + 50);
}

export class MoexLeg {
  private legs: Array<{ spec: MoexSpec; leg: EnsembleLeg }> = [];
  private client: TinkoffClient | null = null;
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private lastQuoteAt = 0;

  constructor(private deps: EnsembleDeps, private specs: MoexSpec[] = MOEX_LEGS) {}

  isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    if (this.running) return;
    if (!config.tinkoffToken) throw new Error('MOEX-нога требует TINKOFF_TOKEN (read-only) в env');
    this.client = new TinkoffClient(config.tinkoffToken);
    this.legs = this.specs.map(spec => ({
      spec,
      leg: new EnsembleLeg(
        this.deps,
        { baseSymbol: spec.ticker, crypto: false, warmup: null, commissionFrac: 0.001 },
        spec.roster,
      ),
    }));
    for (const l of this.legs) await l.leg.start();
    this.running = true;
    this.loopPromise = this.loop();
    log.success(
      `MOEX-нога запущена: ${this.specs.map(s => `${s.ticker} (${s.roster.map(r => r.key).join('+')})`).join(', ')} — виртуально, read-only, комиссия 0.1%/круг в модели`,
      undefined, 'moex',
    );
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.loopPromise) {
      await this.loopPromise.catch(() => {});
      this.loopPromise = null;
    }
    await this.client?.shutdown().catch(() => {});
    this.client = null;
    for (const l of this.legs) l.leg.stop();
    log.info('MOEX-нога остановлена', undefined, 'moex');
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
          const uid = MOEX_INSTRUMENTS[l.spec.ticker]?.uid;
          if (!uid || !this.client) continue;
          const top = await this.client.orderBookTop(uid);
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
      tickers: this.specs.map(s => s.ticker),
      lastQuoteAgoSec: this.lastQuoteAt ? Math.round((Date.now() - this.lastQuoteAt) / 1000) : null,
    };
  }
}
