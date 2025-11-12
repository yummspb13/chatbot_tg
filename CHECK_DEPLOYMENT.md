# Проверка деплоя на Vercel

## Проблема: Endpoint `/api/worker/wake` возвращает 404

Это значит, что последний коммит еще не задеплоен на Vercel.

## Решение 1: Проверить статус деплоя в Vercel Dashboard

1. Откройте [Vercel Dashboard](https://vercel.com/dashboard)
2. Найдите проект `chatbot_tg` (или ваш проект)
3. Проверьте вкладку **Deployments**
4. Убедитесь, что последний коммит `c299cb9` задеплоен
5. Если деплоя нет или он failed, нажмите **Redeploy**

## Решение 2: Запустить деплой вручную через Vercel CLI

```bash
# Установите Vercel CLI (если еще не установлен)
npm i -g vercel

# Войдите в аккаунт (если еще не вошли)
vercel login

# Запустите деплой
vercel --prod
```

## Решение 3: Проверить настройки GitHub интеграции

1. Откройте Vercel Dashboard → Settings → Git
2. Убедитесь, что репозиторий подключен
3. Проверьте, что включен **Automatic deployments from Git**
4. Если нет, включите и сделайте новый push:

```bash
git commit --allow-empty -m "Trigger Vercel deployment"
git push origin main
```

## Решение 4: Временное решение - использовать прямой вызов Worker

Пока деплой не завершится, используйте прямой вызов Worker:

```bash
curl -X POST https://chatbot-tg.onrender.com/runner/wake
```

Или через браузер:
```
https://chatbot-tg.onrender.com/runner/wake
```

## Проверка после деплоя

После завершения деплоя проверьте:

```bash
curl https://chatbot-tg.vercel.app/api/worker/wake
```

Должен вернуть JSON:
```json
{
  "success": true,
  "message": "Worker проверен и пробужден при необходимости",
  "timestamp": "..."
}
```

## Если деплой все еще не работает

1. Проверьте логи сборки в Vercel Dashboard → Deployments → последний деплой → Build Logs
2. Убедитесь, что нет ошибок сборки
3. Проверьте, что файл `app/api/worker/wake/route.ts` существует в репозитории
4. Убедитесь, что `.vercelignore` не игнорирует нужные файлы

