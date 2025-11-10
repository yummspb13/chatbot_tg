# Настройка Render.com для воркера

## Пошаговая инструкция

### 1. Source Code
- ✅ Репозиторий уже подключен: `yummspb13 / chatbot_tg`

### 2. Service Type
- ✅ **Web Service** (уже выбрано)

### 3. Name
- Измените на: `afisha-bot-worker` (или оставьте `chatbot_tg`)

### 4. Language
- ⚠️ **Измените с Python 3 на Node**

### 5. Branch
- ✅ `main` (или ваша рабочая ветка)

### 6. Region
- ✅ `Oregon (US West)` (или ближайший к вам)

### 7. Root Directory
- ⚠️ **ВАЖНО!** Укажите: `worker`
- Это директория, где находится воркер

### 8. Build Command
- ⚠️ **Измените на:** `npm install && npm run build`
- Удалите: `$ pip install -r requirements.txt`

### 9. Start Command
- ⚠️ **Измените на:** `npm start`
- Удалите: `$ gunicorn your_application.wsgi`

### 10. Instance Type
- ⚠️ **ВАЖНО!** Выберите **Starter** ($9/месяц)
- ❌ **НЕ выбирайте Free** - он засыпает после 15 минут бездействия
- MTProto требует постоянного соединения!

### 11. Environment Variables
Добавьте переменные:
```
TELEGRAM_API_ID=17349
TELEGRAM_API_HASH=344583e45741c457fe1862106095a5eb
TELEGRAM_SESSION_STRING= (получите через QR-логин после деплоя)
```

### 12. Deploy
- Нажмите **Deploy Web Service**
- Дождитесь деплоя (2-3 минуты)
- Render даст URL типа: `https://afisha-bot-worker.onrender.com`

---

## После деплоя

1. Откройте админ-панель
2. Перейдите в `/admin/qr-auth`
3. Отсканируйте QR-код для авторизации
4. Получите `TELEGRAM_SESSION_STRING`
5. Добавьте его в Environment Variables в Render
6. Перезапустите сервис (или он перезапустится автоматически)

---

## Обновление .env в админ-панели

После деплоя обновите `.env` в админ-панели (Vercel):

```
NEXT_PUBLIC_WORKER_URL=https://afisha-bot-worker.onrender.com
```

---

## Проверка работы

После деплоя проверьте:

```bash
curl https://afisha-bot-worker.onrender.com/health
```

Должен вернуть:
```json
{"status":"ok","timestamp":"..."}
```

