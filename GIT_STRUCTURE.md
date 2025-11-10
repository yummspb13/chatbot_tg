# Структура Git репозитория

## Один репозиторий для обоих сервисов

**GitHub:** `yummspb13/chatbot_tg`

---

## Render.com (Воркер)

- **Репозиторий:** `yummspb13/chatbot_tg`
- **Root Directory:** `worker` ⚠️
- **Build Command:** `npm install && npm run build`
- **Start Command:** `npm start`

**Что деплоится:**
- `worker/package.json`
- `worker/src/`
- `worker/tsconfig.json`

---

## Vercel (Админ-панель)

- **Репозиторий:** `yummspb13/chatbot_tg`
- **Root Directory:** `.` (корень) ⚠️
- **Build Command:** `npm run build` (по умолчанию)
- **Start Command:** `npm start` (по умолчанию)

**Что деплоится:**
- `package.json` (корневой)
- `app/`
- `lib/`
- `prisma/`
- Все остальное, кроме `worker/`

---

## Как это работает

1. **Push в GitHub** → оба сервиса автоматически обновляются
2. **Render.com** смотрит только в `worker/`
3. **Vercel** смотрит в корень (игнорирует `worker/`)

---

## Преимущества

✅ Один репозиторий - проще управлять  
✅ Один push - оба сервиса обновляются  
✅ Вся история в одном месте  

---

## Важно

- При изменении кода в `worker/` → обновится только Render.com
- При изменении кода в `app/` или `lib/` → обновится только Vercel
- При изменении `package.json` в корне → обновится только Vercel
- При изменении `worker/package.json` → обновится только Render.com

---

## Проверка

После push в GitHub:
- Render.com автоматически задеплоит воркер
- Vercel автоматически задеплоит админ-панель

Оба сервиса независимы, но используют один репозиторий!

