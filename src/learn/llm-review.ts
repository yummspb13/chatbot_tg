// «Обучение», часть 3 (опционально): ежедневный LLM-разбор журнала сделок.
// Решений не принимает — только человекочитаемый отчёт в Telegram.
// Включается наличием OPENAI_API_KEY (у владельца уже есть ключ от прошлого проекта).

import { request } from 'undici';
import { config } from '../config';
import { errMsg, log } from '../logger';
import type { TradeStore } from '../store';

export async function runDailyLlmReview(
  store: TradeStore,
  notify: (text: string) => Promise<void>,
): Promise<void> {
  if (!config.openaiKey) return;
  try {
    const settings = await store.getSettings();
    const since = new Date(Date.now() - 86400_000);
    const trades = await store.closedTradesSince(settings.mode, since);
    if (trades.length < 3) return;

    const compact = trades.map(t => ({
      side: t.side,
      pnl: Number((t.pnl ?? 0).toFixed(2)),
      reason: t.closeReason,
      hourUtc: t.hourUtc,
      spreadPips: t.spreadAtEntry ? Number(t.spreadAtEntry.toFixed(1)) : null,
      volPips: t.volAtEntry ? Number(t.volAtEntry.toFixed(1)) : null,
      newsDistMin: t.newsDistMin,
    }));

    const res = await request('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.openaiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: config.openaiModel,
        max_tokens: 500,
        messages: [
          {
            role: 'system',
            content: 'Ты трейдинг-аналитик тестового FX-агента (EUR/USD, momentum, микро-объёмы). '
              + 'Кратко (до 5 пунктов, по-русски) разбери сделки за сутки: паттерны убытков/прибыли по часам, '
              + 'спреду, волатильности; заметь, если издержки съедают результат. Можно предложить, какие параметры '
              + 'стоит проверить бэктестом. Никаких обещаний доходности, решения принимает человек.',
          },
          {
            role: 'user',
            content: `Параметры: ${JSON.stringify(settings.params)}\nСделки за 24ч: ${JSON.stringify(compact)}`,
          },
        ],
      }),
      headersTimeout: 20_000,
      bodyTimeout: 60_000,
    });
    const text = await res.body.text();
    if (res.statusCode >= 300) throw new Error(`OpenAI ${res.statusCode}: ${text.slice(0, 200)}`);
    const data = JSON.parse(text);
    const content: string | undefined = data.choices?.[0]?.message?.content;
    if (content) await notify(`🧠 LLM-дневник (за 24ч, ${trades.length} сделок):\n${content.slice(0, 3500)}`);
  } catch (e) {
    log.warn(`llm review: ${errMsg(e)}`, undefined, 'learn');
  }
}
