// Монитор треугольного арбитража обменника Т-Банка (вопрос владельца 12.08:
// знакомый ловил цикл рубль→фунт→доллар→рубль в приложении).
//
// Истории банковских курсов не существует публично — проверить «было ли»
// задним числом нельзя. Поэтому копим СВОЮ историю: раз в 5 минут снимаем
// курсы карточного обменника (публичный api.tinkoff.ru/v1/currency_rates,
// категория DebitCardsTransfers — то, что видно в приложении) и считаем все
// циклы RUB→A→B→RUB. Семантика пары from=A,to=B: buy/sell в единицах B за 1 A;
// «buy» — банк покупает A у клиента, «sell» — продаёт.
//
// Рамка честности: на 12.08 спреды запретительные (GBP 40%, кроссы ±20% —
// цикл через GBP возвращает 0.65₽ с рубля). Монитор ищет МОМЕНТЫ рассинхрона
// курсов при рывках рынка. Даже пойманное окно — не кнопка «деньги»: банки
// режут обменный арбитраж по договору. Мы наблюдаем и алертим, решения — у
// владельца.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Agent, Dispatcher, ProxyAgent, request } from 'undici';
import { errMsg, log } from '../logger';

const CURRENCIES = ['USD', 'EUR', 'GBP', 'CNY', 'AED', 'TRY', 'KZT'];
const CATEGORY = 'DebitCardsTransfers';
const SWEEP_MS = 5 * 60_000;

interface Rate {
  buy: number;
  sell: number;
  at: number;
}

export interface TriangleBest {
  path: string;
  k: number; // 1₽ через цикл → k₽
  at: string;
}

export class TriangleMonitor {
  private dispatcher: Dispatcher;
  private rates = new Map<string, Rate>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastSweepAt = 0;
  bestNow: TriangleBest | null = null;
  bestToday: TriangleBest | null = null;
  private bestDayKey = '';
  private lastAlertAt = 0;

  constructor(private notify: (text: string) => Promise<void>) {
    const ca = readFileSync(path.join(process.cwd(), 'certs', 'russian-trusted-root.pem'));
    const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
    this.dispatcher = proxy
      ? new ProxyAgent({ uri: proxy, requestTls: { ca } })
      : new Agent({ connect: { ca } });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.sweep();
    this.timer = setInterval(() => void this.sweep(), SWEEP_MS);
    this.timer.unref();
    log.success(
      `монитор треугольников обменника запущен: ${CURRENCIES.join('/')}, свип 5 мин, алерт при цикле ≥0.995`,
      undefined, 'triangle',
    );
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async fetchPair(from: string, to: string): Promise<void> {
    const res = await request(`https://api.tinkoff.ru/v1/currency_rates?from=${from}&to=${to}`, {
      dispatcher: this.dispatcher,
      headersTimeout: 15_000,
      bodyTimeout: 15_000,
    });
    const body = await res.body.json() as any;
    const r = (body?.payload?.rates ?? []).find((x: any) => x.category === CATEGORY);
    if (r?.buy && r?.sell) this.rates.set(`${from}/${to}`, { buy: r.buy, sell: r.sell, at: Date.now() });
  }

  private async sweep(): Promise<void> {
    if (!this.running) return;
    try {
      for (const c of CURRENCIES) await this.fetchPair(c, 'RUB');
      for (const a of CURRENCIES) {
        for (const b of CURRENCIES) {
          if (a !== b) await this.fetchPair(a, b);
        }
      }
      this.lastSweepAt = Date.now();
      this.evaluate();
    } catch (e) {
      log.warn(`монитор треугольников: ${errMsg(e)}`, undefined, 'triangle');
    }
  }

  private evaluate(): void {
    let best: TriangleBest | null = null;
    for (const a of CURRENCIES) {
      for (const b of CURRENCIES) {
        if (a === b) continue;
        const aRub = this.rates.get(`${a}/RUB`);
        const ab = this.rates.get(`${a}/${b}`);
        const bRub = this.rates.get(`${b}/RUB`);
        if (!aRub || !ab || !bRub) continue;
        // 1₽ → A (платим sell A/RUB) → B (получаем buy пары A/B) → ₽ (получаем buy B/RUB)
        const k = (1 / aRub.sell) * ab.buy * bRub.buy;
        if (!best || k > best.k) best = { path: `RUB→${a}→${b}→RUB`, k: +k.toFixed(4), at: new Date().toISOString() };
      }
    }
    if (!best) return;
    this.bestNow = best;
    const day = best.at.slice(0, 10);
    if (day !== this.bestDayKey || !this.bestToday || best.k > this.bestToday.k) {
      if (day !== this.bestDayKey) this.bestToday = best;
      else if (best.k > (this.bestToday?.k ?? 0)) this.bestToday = best;
      this.bestDayKey = day;
    }
    if (best.k >= 0.995 && Date.now() - this.lastAlertAt > 30 * 60_000) {
      this.lastAlertAt = Date.now();
      const profit100k = Math.round((best.k - 1) * 100_000);
      void this.notify(
        best.k >= 1
          ? `🚨 ОКНО обменника: цикл ${best.path} = ${best.k} (${profit100k >= 0 ? '+' : ''}${profit100k}₽ на 100к₽ до лимитов банка). Курсы живут секунды — это сигнал, не кнопка.`
          : `👀 Обменник близко к окну: ${best.path} = ${best.k}. Наблюдаю каждые 5 мин.`,
      );
    }
  }

  summary() {
    return {
      running: this.running,
      lastSweepAgoSec: this.lastSweepAt ? Math.round((Date.now() - this.lastSweepAt) / 1000) : null,
      bestNow: this.bestNow,
      bestToday: this.bestToday,
    };
  }
}
