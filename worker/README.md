# Telegram Client API Worker

Отдельный воркер для MTProto-клиента Telegram. Работает как постоянный процесс на VM/Render/Fly/Railway.

## Запуск

```bash
# Установка зависимостей
npm install

# Разработка (с автоперезагрузкой)
npm run dev

# Продакшен
npm run build
npm start
```

## API Endpoints

### QR-авторизация

- `POST /auth/qr/start` - Начинает QR-авторизацию, возвращает QR-код
- `POST /auth/qr/status` - Проверяет статус авторизации
- `POST /auth/qr/password` - Обрабатывает пароль 2FA
- `POST /auth/qr/save` - Сохраняет sessionString

### Управление воркером

- `POST /runner/start` - Запускает воркер
- `POST /runner/stop` - Останавливает воркер
- `GET /runner/status` - Статус воркера

### Health check

- `GET /health` - Проверка работоспособности

## Переменные окружения

- `TELEGRAM_API_ID` - API ID (опционально, по умолчанию 17349)
- `TELEGRAM_API_HASH` - API Hash (опционально, по умолчанию стандартный)
- `TELEGRAM_SESSION_STRING` - Сессия Telegram (получается через QR-логин)
- `WORKER_PORT` - Порт воркера (по умолчанию 3001)

## Деплой

### Render.com

1. Создайте новый Web Service
2. Подключите репозиторий
3. Build Command: `cd worker && npm install && npm run build`
4. Start Command: `cd worker && npm start`
5. Добавьте переменные окружения

### Fly.io

```bash
fly launch
fly deploy
```

### Railway

1. Создайте новый проект
2. Подключите репозиторий
3. Укажите root directory: `worker`
4. Start command: `npm start`
5. Добавьте переменные окружения

