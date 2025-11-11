# Добавление API credentials

## ✅ Получены credentials:

```
TELEGRAM_API_ID=32425884
TELEGRAM_API_HASH=ecdaac5d16a48465d993985dbda6399c
```

## 📝 Добавьте в .env файл:

Откройте файл `.env` в корне проекта и добавьте (или обновите) эти строки:

```env
TELEGRAM_API_ID=32425884
TELEGRAM_API_HASH=ecdaac5d16a48465d993985dbda6399c
```

## 🔧 Или через терминал:

```bash
# Если .env уже существует:
echo 'TELEGRAM_API_ID=32425884' >> .env
echo 'TELEGRAM_API_HASH=ecdaac5d16a48465d993985dbda6399c' >> .env

# Или отредактируйте вручную:
nano .env
# или
code .env
```

## ✅ После добавления:

1. Получите сессию для @yummspb:
   ```bash
   npm run client:setup
   ```

2. Или используйте Python скрипт:
   ```bash
   python3 scripts/get-session.py
   ```

3. Скопируйте полученную `TELEGRAM_SESSION_STRING`

4. Добавьте её в Render.com Environment Variables

