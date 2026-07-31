// «Обучение», часть 2: еженедельный ребэктест на свежей истории → ParamProposal.
// Предложение НЕ применяется само — только после аппрува в PWA (или вручную).
// Включается env AUTO_RETRAIN=1 (на слабом хостинге лучше гонять руками: npm run backtest -- --optimize).

import { config } from '../config';
import { errMsg, log } from '../logger';
import { clampParams } from '../agent/params';
import { loadM1 } from '../backtest/data';
import { optimize, runBacktest } from '../backtest/runner';
import type { TradeStore } from '../store';

export async function runWeeklyRetrain(
  store: TradeStore,
  notify: (text: string) => Promise<void>,
): Promise<void> {
  if (!config.autoRetrain) return;
  try {
    const to = new Date();
    const from = new Date(to.getTime() - 90 * 86400_000);
    const candles = await loadM1(from, to);
    if (candles.length < 20_000) {
      log.warn('ребэктест: мало данных, пропуск', undefined, 'learn');
      return;
    }
    const settings = await store.getSettings();
    const opt = optimize(candles, 0.7, settings.params.units);
    if (!opt.best) return;

    const cut = Math.floor(candles.length * 0.7);
    const currentOnTest = runBacktest(candles.slice(cut), settings.params);
    if (opt.best.test.netUsd <= Math.max(0, currentOnTest.netUsd)) {
      log.info('ребэктест: текущие параметры не хуже — предложения нет', undefined, 'learn');
      return;
    }

    const proposed = clampParams({ ...settings.params, ...opt.best.params });
    const p = await store.createProposal(proposed, {
      window: '90d',
      best: { params: opt.best.params, trainNetUsd: opt.best.train.netUsd, testNetUsd: opt.best.test.netUsd, testTrades: opt.best.test.trades },
      currentTestNetUsd: currentOnTest.netUsd,
    });
    await notify(
      `🧪 Еженедельный ребэктест (90 дней): предложение параметров #${p.id}\n`
      + `Кандидат: ${JSON.stringify(opt.best.params)}\n`
      + `Test-период: кандидат ${opt.best.test.netUsd.toFixed(2)}$ vs текущие ${currentOnTest.netUsd.toFixed(2)}$\n`
      + 'Применить/отклонить — в PWA (раздел «Предложения»). Само не применится.',
    );
  } catch (e) {
    log.warn(`weekly retrain: ${errMsg(e)}`, undefined, 'learn');
  }
}
