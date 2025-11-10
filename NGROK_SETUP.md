# Настройка ngrok для Webhook

## ✅ ngrok уже установлен в `~/ngrok/ngrok`

## Первый запуск (требуется регистрация)

1. **Зарегистрируйтесь на https://ngrok.com** (бесплатно)

2. **Получите authtoken** в личном кабинете

3. **Добавьте authtoken:**
   ```bash
   ~/ngrok/ngrok config add-authtoken <ваш-token>
   ```

## Запуск и настройка webhook

### Вариант 1: Автоматически

```bash
bash scripts/start-ngrok-and-setup.sh
```

### Вариант 2: Вручную

1. **Запустите ngrok в отдельном терминале:**
   ```bash
   ~/ngrok/ngrok http 3002
   ```

2. **Скопируйте HTTPS URL** из вывода (например: `https://abc123.ngrok-free.app`)

3. **Установите webhook:**
   ```bash
   npm run webhook:set https://abc123.ngrok-free.app/api/tg/webhook
   ```

4. **Проверьте статус:**
   ```bash
   npm run webhook:info
   ```

## Добавление ngrok в PATH (опционально)

Добавьте в `~/.zshrc`:
```bash
export PATH="$HOME/ngrok:$PATH"
```

Затем:
```bash
source ~/.zshrc
```

Теперь можно использовать просто `ngrok` вместо `~/ngrok/ngrok`

