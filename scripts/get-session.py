#!/usr/bin/env python3
"""
Скрипт для получения сессии Telegram БЕЗ создания приложения
Использует стандартные API credentials
"""

from telethon import TelegramClient
from telethon.sessions import StringSession

# Стандартные credentials (не требуют создания приложения)
API_ID = 17349
API_HASH = '344583e45741c457fe1862106095a5eb'

async def main():
    print('🔐 Получение сессии Telegram')
    print('📱 Используем стандартные credentials (не требуют создания приложения)')
    print('')
    
    async with TelegramClient(StringSession(), API_ID, API_HASH) as client:
        print('📱 Войдите в Telegram...')
        print('   (Откроется окно авторизации или попросит код)')
        print('')
        
        await client.start()
        
        session_string = client.session.save()
        
        print('')
        print('✅ Сессия получена!')
        print('')
        print('📋 Добавьте в .env файл:')
        print('')
        print(f'TELEGRAM_API_ID={API_ID}')
        print(f'TELEGRAM_API_HASH={API_HASH}')
        print(f'TELEGRAM_SESSION_STRING="{session_string}"')
        print('')
        print('💡 Сохраните эту строку безопасно!')

if __name__ == '__main__':
    import asyncio
    asyncio.run(main())

