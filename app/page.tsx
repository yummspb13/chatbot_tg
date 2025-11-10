export default function Home() {
  return (
    <main style={{ padding: '2rem', fontFamily: 'system-ui' }}>
      <h1>🤖 Telegram Bot для Афиши</h1>
      <p>Бот запущен и готов к работе!</p>
      
      <div style={{ marginTop: '2rem' }}>
        <h2>API Endpoints:</h2>
        <ul>
          <li>
            <strong>POST</strong> <code>/api/tg/webhook</code> - Webhook для Telegram
          </li>
          <li>
            <strong>GET/POST</strong> <code>/api/bot/learning/export</code> - Экспорт данных обучения
          </li>
        </ul>
      </div>

      <div style={{ marginTop: '2rem', padding: '1rem', background: '#f0f0f0', borderRadius: '8px' }}>
        <h3>Статус:</h3>
        <p>✅ Сервер работает</p>
        <p>✅ База данных подключена</p>
        <p>✅ Webhook endpoint готов</p>
      </div>

      <div style={{ marginTop: '2rem' }}>
        <h3>Следующие шаги:</h3>
        <ol>
          <li>Настройте webhook в Telegram Bot API</li>
          <li>Добавьте каналы через команды бота</li>
          <li>Запустите бота командой <code>/start</code></li>
        </ol>
      </div>
    </main>
  )
}

