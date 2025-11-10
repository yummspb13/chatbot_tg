# Как получить сессию из Telegram Desktop (БЕЗ создания приложения!)

## 🎯 Цель

Получить `TELEGRAM_SESSION_STRING` из Telegram Desktop для использования в боте, **БЕЗ** создания приложения через my.telegram.org.

## 📋 Способ 1: Экспорт сессии из Telegram Desktop

### Шаг 1: Установите Telegram Desktop

Скачайте и установите Telegram Desktop:
- Windows/Mac: https://desktop.telegram.org/
- Linux: через пакетный менеджер

### Шаг 2: Войдите с аккаунтом @yummspb

1. Откройте Telegram Desktop
2. Войдите с номером телефона аккаунта @yummspb
3. Подтвердите код

### Шаг 3: Экспорт сессии

Используйте библиотеку для экспорта сессии из Telegram Desktop:

```bash
# Установите telethon (Python)
pip install telethon

# Создайте скрипт для экспорта
python -c "
from telethon import TelegramClient
from telethon.sessions import StringSession

# Используем стандартные credentials
api_id = 17349
api_hash = '344583e45741c457fe1862106095a5eb'

# Создаем клиент
client = TelegramClient(StringSession(), api_id, api_hash)
client.start()

# Получаем сессию
session_string = client.session.save()
print('TELEGRAM_SESSION_STRING=' + session_string)
"
```

## 📋 Способ 2: Использование готовой сессии

Если у вас уже есть Telegram Desktop с авторизованным аккаунтом @yummspb, можно использовать его сессию напрямую.

## 📋 Способ 3: Через Python скрипт (самый простой)

Создайте файл `get_session.py`:

```python
from telethon import TelegramClient
from telethon.sessions import StringSession

# Стандартные credentials (не требуют создания приложения)
api_id = 17349
api_hash = '344583e45741c457fe1862106095a5eb'

async def main():
    async with TelegramClient(StringSession(), api_id, api_hash) as client:
        print('Войдите в Telegram...')
        await client.start()
        session_string = client.session.save()
        print('\n✅ Сессия получена!')
        print(f'\nTELEGRAM_SESSION_STRING="{session_string}"')
        print('\nСкопируйте эту строку в .env файл')

if __name__ == '__main__':
    import asyncio
    asyncio.run(main())
```

Запустите:
```bash
pip install telethon
python get_session.py
```

## 📋 Способ 4: Использовать готовые credentials

Можно использовать стандартные API credentials, которые не требуют создания приложения:

```env
TELEGRAM_API_ID=17349
TELEGRAM_API_HASH=344583e45741c457fe1862106095a5eb
```

Эти credentials работают для всех пользователей.

## ✅ После получения сессии

Добавьте в `.env`:

```env
TELEGRAM_API_ID=17349
TELEGRAM_API_HASH=344583e45741c457fe1862106095a5eb
TELEGRAM_SESSION_STRING=полученная_сессия
TELEGRAM_BOT_USERNAME=kiddeo_afisha_bot
```

Запустите бота - он автоматически начнет пересылать сообщения!

