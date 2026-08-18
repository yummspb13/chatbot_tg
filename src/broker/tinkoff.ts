// Клиент T-Invest API (REST-шлюз gRPC) — только ЧТЕНИЕ рыночных данных для
// виртуальной MOEX-ноги. Никаких торговых вызовов в этом файле нет и не будет,
// пока владелец явно не решит идти дальше виртуальной фазы.
//
// TLS: у *.tinkoff.ru цепочка Минцифры (Russian Trusted Root CA), которой нет
// в западных хранилищах. Пиним корень локально (certs/russian-trusted-root.pem,
// sha256 D2:6D:2D:02:31:B7:C3:9F:92:CC:73:85:12:BA:54:10:35:19:E4:40:5D:68:
// B5:BD:70:3E:97:88:CA:8E:CF:31) и доверяем ему ТОЛЬКО для этого клиента —
// глобальное хранилище не трогаем.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Agent, Dispatcher, ProxyAgent, request } from 'undici';
import { sleep } from './types';

const BASE = 'https://invest-public-api.tinkoff.ru/rest/tinkoff.public.invest.api.contract.v1';

// проверено 04.08.2026 через ShareBy (класс TQBR)
export const MOEX_INSTRUMENTS: Record<string, { uid: string; lot: number }> = {
  TATN: { uid: '88468f6c-c67a-4fb4-a006-53eed803883c', lot: 1 },
  GAZP: { uid: '962e2a95-02a9-4171-abd7-aa198dbe643a', lot: 10 },
  ROSN: { uid: 'fd417230-19cf-4e7b-9623-f7c9ca18ec6b', lot: 1 },
  SBER: { uid: 'e6123145-9665-43e0-8413-cd61b8aa9b13', lot: 1 },
};

interface Money {
  units?: string | number;
  nano?: number;
}

function num(p: Money | undefined): number | null {
  if (!p) return null;
  const u = Number(p.units ?? 0);
  const n = (p.nano ?? 0) / 1e9;
  const v = u + n;
  return Number.isFinite(v) ? v : null;
}

/** Обратная конверсия для тел запросов (Quotation/MoneyValue). */
export function toMoney(v: number): { units: string; nano: number } {
  const units = Math.trunc(v);
  const nano = Math.round((v - units) * 1e9);
  return { units: String(units), nano };
}

export { num as moneyNum };

export class TinkoffClient {
  private dispatcher: Dispatcher;

  constructor(private token: string) {
    const ca = readFileSync(path.join(process.cwd(), 'certs', 'russian-trusted-root.pem'));
    // undici не читает переменные прокси сам: в средах с HTTPS_PROXY (дев-контейнер)
    // ходим через него, на Render — напрямую; пин CA действует в обоих случаях
    const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
    this.dispatcher = proxy
      ? new ProxyAgent({ uri: proxy, requestTls: { ca } })
      : new Agent({ connect: { ca } });
  }

  protected async call<T>(service: string, method: string, body: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await request(`${BASE}.${service}/${method}`, {
        method: 'POST',
        dispatcher: this.dispatcher,
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        headersTimeout: 15_000,
        bodyTimeout: 15_000,
      });
      const text = await res.body.text();
      if (res.statusCode === 429 && attempt < 3) {
        await sleep(2000 * 2 ** attempt); // ratelimit — подождать и повторить
        continue;
      }
      if (res.statusCode !== 200) {
        throw new Error(`tinkoff ${method}: HTTP ${res.statusCode} ${text.slice(0, 80)}`);
      }
      return JSON.parse(text) as T;
    }
  }

  /** uid инструмента по тикеру (класс TQBR). */
  async shareUid(ticker: string): Promise<string> {
    return (await this.shareInfo(ticker)).uid;
  }

  /** uid + размер лота + шаг цены — зеркалу нужны для реальных ордеров. */
  async shareInfo(ticker: string): Promise<{ uid: string; lot: number; priceStep: number }> {
    const d = await this.call<any>('InstrumentsService', 'ShareBy', {
      idType: 'INSTRUMENT_ID_TYPE_TICKER', classCode: 'TQBR', id: ticker,
    });
    return {
      uid: d.instrument.uid as string,
      lot: Number(d.instrument.lot ?? 1),
      priceStep: num(d.instrument.minPriceIncrement) ?? 0.01,
    };
  }

  /** Верх стакана: bid/ask (null — на аукционе/вне сессии) + последняя цена. */
  async orderBookTop(uid: string): Promise<{ bid: number | null; ask: number | null; last: number | null }> {
    const d = await this.call<any>('MarketDataService', 'GetOrderBook', { instrumentId: uid, depth: 1 });
    return {
      bid: d.bids?.length ? num(d.bids[0].price) : null,
      ask: d.asks?.length ? num(d.asks[0].price) : null,
      last: num(d.lastPrice),
    };
  }

  async shutdown(): Promise<void> {
    await this.dispatcher.close().catch(() => {});
  }
}
