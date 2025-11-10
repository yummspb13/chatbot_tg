# Деплой воркера

Воркер требует постоянного процесса (MTProto-соединение), поэтому его нельзя деплоить на Vercel.

## Варианты деплоя

### 1. Render.com (рекомендуется для начала)

**Бесплатный тариф:** есть, но с ограничениями (засыпает после 15 минут бездействия)

**Платный тариф:** от $7/месяц (постоянный процесс)

**Шаги:**
1. Зарегистрируйтесь на [render.com](https://render.com)
2. В Dashboard нажмите **New +** → **Web Service**
3. Подключите GitHub репозиторий (или используйте Public Git репозиторий)
4. Настройки:
   - **Name:** `afisha-bot-worker`
   - **Root Directory:** `worker` (важно!)
   - **Environment:** `Node`
   - **Build Command:** `npm install && npm run build`
   - **Start Command:** `npm start`
   - **Plan:** `Starter` ($7/месяц) - для постоянной работы
     - ⚠️ **Бесплатный тариф засыпает после 15 минут бездействия!**
     - Для MTProto-соединения нужен платный тариф
5. Добавьте переменные окружения в разделе **Environment**:
   ```
   TELEGRAM_API_ID=17349
   TELEGRAM_API_HASH=344583e45741c457fe1862106095a5eb
   TELEGRAM_SESSION_STRING= (получите через QR-логин после деплоя)
   PORT=10000 (Render сам назначит, но можно указать явно)
   ```
6. Нажмите **Create Web Service**
7. Дождитесь деплоя (обычно 2-3 минуты)
8. Render даст URL типа: `https://afisha-bot-worker.onrender.com`

**Важно:** 
- На бесплатном тарифе сервис засыпает после 15 минут бездействия
- Для постоянной работы MTProto-соединения нужен платный тариф **Starter** ($7/месяц)
- После деплоя обновите `.env` в админ-панели:
  ```
  NEXT_PUBLIC_WORKER_URL=https://afisha-bot-worker.onrender.com
  ```

---

### 2. Railway.app (простой деплой)

**Бесплатный тариф:** $5 кредитов в месяц (хватит на небольшой проект)

**Шаги:**
1. Зарегистрируйтесь на [railway.app](https://railway.app)
2. Создайте новый проект
3. **Deploy from GitHub repo**
4. Выберите репозиторий
5. Настройки:
   - **Root Directory:** `worker`
   - **Start Command:** `npm start`
6. Добавьте переменные окружения в разделе **Variables**
7. Railway автоматически определит порт (используйте `process.env.PORT`)

**Плюсы:** Простой деплой, автоматический HTTPS, хорошая документация

---

### 3. Fly.io (хорошо для постоянных процессов)

**Бесплатный тариф:** есть (ограниченные ресурсы)

**Шаги:**
1. Установите Fly CLI: `curl -L https://fly.io/install.sh | sh`
2. Войдите: `fly auth login`
3. Создайте приложение: `cd worker && fly launch`
4. Настройте `fly.toml` (уже создан)
5. Добавьте секреты:
   ```bash
   fly secrets set TELEGRAM_API_ID=17349
   fly secrets set TELEGRAM_API_HASH=344583e45741c457fe1862106095a5eb
   fly secrets set TELEGRAM_SESSION_STRING="..."
   ```
6. Деплой: `fly deploy`

---

### 4. Локально (для разработки/тестирования)

**Для тестирования можно запустить локально:**

```bash
# В директории проекта
cd worker
npm install
npm run dev
```

Воркер запустится на `http://localhost:3001`

**Важно:** Нужно, чтобы админ-панель могла достучаться до воркера. Если админ-панель на Vercel, а воркер локально - используйте ngrok:

```bash
# В другом терминале
ngrok http 3001
```

Или используйте `cloudflared`:
```bash
cloudflared tunnel --url http://localhost:3001
```

Затем в `.env` админ-панели:
```
NEXT_PUBLIC_WORKER_URL=https://your-ngrok-url.ngrok.io
```

---

### 5. VPS/VM (полный контроль)

**Варианты:**
- DigitalOcean Droplet ($6/месяц)
- Hetzner Cloud (€4/месяц)
- AWS EC2 (pay-as-you-go)
- Google Cloud Run (pay-as-you-go)

**Шаги:**
1. Создайте VM (Ubuntu 22.04)
2. Установите Node.js:
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt-get install -y nodejs
   ```
3. Клонируйте репозиторий
4. Установите зависимости: `cd worker && npm install`
5. Настройте `.env`
6. Запустите через PM2 (для постоянной работы):
   ```bash
   npm install -g pm2
   pm2 start npm --name "afisha-worker" -- start
   pm2 save
   pm2 startup
   ```

---

## Рекомендация для MVP

**Для начала:** Railway.app или Render.com (платный тариф)

**Для продакшена:** Fly.io или VPS (больше контроля)

---

## Настройка админ-панели

После деплоя воркера, обновите `.env` в админ-панели:

```env
# URL воркера (замените на ваш)
NEXT_PUBLIC_WORKER_URL=https://your-worker.railway.app
# или
NEXT_PUBLIC_WORKER_URL=https://your-worker.fly.dev
# или
NEXT_PUBLIC_WORKER_URL=https://your-worker.onrender.com
```

---

## Проверка работы

После деплоя проверьте:

1. Health check: `curl https://your-worker-url/health`
2. Должен вернуть: `{"status":"ok","timestamp":"..."}`

Если не работает - проверьте логи в панели управления хостинга.

