# Панель FX Agent для Vercel

Прокси-зеркало PWA агента: Vercel даёт стабильный URL и зелёные деплои,
сам движок остаётся на Render (serverless его цикл котировок не потянет).

## Подключение (один раз, ~1 минута)

1. https://vercel.com/new → Import Git Repository → `yummspb13/chatbot_tg`.
2. **Root Directory: `panel`** (важно! иначе Vercel попытается собрать корень).
3. Deploy. Проект получит имя `panel` — переименуйте в `fx-agent` при желании.
4. Settings → Environment Variables → `AGENT_URL` = URL агента на Render
   (например `https://fx-agent.onrender.com`) → Redeploy.

После этого пуши в репозиторий автоматически деплоят панель (root=panel),
а корневой `vercel.json` продолжает глушить сборки старого проекта chatbot-tg.
