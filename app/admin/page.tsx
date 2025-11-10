import { redirect } from 'next/navigation'
import { verifySession } from '@/lib/auth/session'
import { cookies } from 'next/headers'
import Link from 'next/link'

async function getBotStatus() {
  const { prisma } = await import('@/lib/db/prisma')
  const settings = await prisma.botSettings.findFirst()
  const channels = await prisma.channel.count({ where: { isActive: true } })
  const drafts = await prisma.draftEvent.count({ where: { status: 'NEW' } })
  const { getLearningStats } = await import('@/lib/learning/decisionService')
  const stats = await getLearningStats()

  return {
    settings,
    channels,
    drafts,
    stats,
  }
}

export default async function AdminDashboard() {
  const cookieStore = await cookies()
  const token = cookieStore.get('admin-token')?.value

  if (!token) {
    redirect('/admin/login')
  }

  const session = await verifySession(token)
  if (!session) {
    redirect('/admin/login')
  }

  const { settings, channels, drafts, stats } = await getBotStatus()

  return (
    <div style={{ padding: '2rem', fontFamily: 'system-ui', maxWidth: '1200px', margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
        <h1>🤖 Админ-панель бота</h1>
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
          <Link href="/admin/qr-auth" style={{
            padding: '0.5rem 1rem',
            background: '#28a745',
            color: 'white',
            textDecoration: 'none',
            borderRadius: '6px',
            fontSize: '0.9rem',
            display: 'inline-block'
          }}>
            📱 QR-авторизация
          </Link>
          <span style={{ marginRight: '1rem' }}>👤 {session.username}</span>
          <form action="/api/admin/auth" method="POST">
            <button type="submit" style={{
              padding: '0.5rem 1rem',
              background: '#dc3545',
              color: 'white',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer'
            }}>
              Выйти
            </button>
          </form>
        </div>
      </div>

      <nav style={{
        display: 'flex',
        gap: '1rem',
        marginBottom: '2rem',
        paddingBottom: '1rem',
        borderBottom: '2px solid #eee'
      }}>
        <Link href="/admin" style={{ padding: '0.5rem 1rem', background: '#667eea', color: 'white', borderRadius: '6px', textDecoration: 'none' }}>
          📊 Дашборд
        </Link>
        <Link href="/admin/cities" style={{ padding: '0.5rem 1rem', background: '#f0f0f0', borderRadius: '6px', textDecoration: 'none' }}>
          🏙️ Города
        </Link>
        <Link href="/admin/channels" style={{ padding: '0.5rem 1rem', background: '#f0f0f0', borderRadius: '6px', textDecoration: 'none' }}>
          📡 Каналы
        </Link>
        <Link href="/admin/drafts" style={{ padding: '0.5rem 1rem', background: '#f0f0f0', borderRadius: '6px', textDecoration: 'none' }}>
          📝 Черновики
        </Link>
        <Link href="/admin/settings" style={{ padding: '0.5rem 1rem', background: '#f0f0f0', borderRadius: '6px', textDecoration: 'none' }}>
          ⚙️ Настройки
        </Link>
        <Link href="/admin/learning" style={{ padding: '0.5rem 1rem', background: '#f0f0f0', borderRadius: '6px', textDecoration: 'none' }}>
          🎓 Обучение
        </Link>
      </nav>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: '1.5rem', marginBottom: '2rem' }}>
        <div style={{ padding: '1.5rem', background: '#f8f9fa', borderRadius: '8px' }}>
          <h3 style={{ marginTop: 0 }}>Статус бота</h3>
          <p style={{ fontSize: '1.5rem', fontWeight: 'bold', color: settings?.isRunning ? '#28a745' : '#dc3545' }}>
            {settings?.isRunning ? '✅ Работает' : '⏹ Остановлен'}
          </p>
          <p>Режим: {settings?.mode === 'AUTO' ? '🤖 Автоматический' : '👤 Ручной'}</p>
        </div>

        <div style={{ padding: '1.5rem', background: '#f8f9fa', borderRadius: '8px' }}>
          <h3 style={{ marginTop: 0 }}>Каналы</h3>
          <p style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>{channels}</p>
          <p>активных каналов</p>
        </div>

        <div style={{ padding: '1.5rem', background: '#f8f9fa', borderRadius: '8px' }}>
          <h3 style={{ marginTop: 0 }}>Черновики</h3>
          <p style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>{drafts}</p>
          <p>новых мероприятий</p>
        </div>

        <div style={{ padding: '1.5rem', background: '#f8f9fa', borderRadius: '8px' }}>
          <h3 style={{ marginTop: 0 }}>Обучение</h3>
          <p style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>{stats.accuracy}%</p>
          <p>точность агента ({stats.total} решений)</p>
        </div>
      </div>

      <div style={{ padding: '1.5rem', background: '#fff', borderRadius: '8px', border: '1px solid #eee' }}>
        <h2>Быстрые действия</h2>
        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
          <form action="/api/admin/bot/start" method="POST">
            <button type="submit" style={{
              padding: '0.75rem 1.5rem',
              background: '#28a745',
              color: 'white',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer',
              fontSize: '1rem'
            }}>
              ▶️ Запустить бота
            </button>
          </form>
          <form action="/api/admin/bot/stop" method="POST">
            <button type="submit" style={{
              padding: '0.75rem 1.5rem',
              background: '#dc3545',
              color: 'white',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer',
              fontSize: '1rem'
            }}>
              ⏹ Остановить бота
            </button>
          </form>
          <Link href="/admin/cities" style={{
            padding: '0.75rem 1.5rem',
            background: '#667eea',
            color: 'white',
            border: 'none',
            borderRadius: '6px',
            cursor: 'pointer',
            fontSize: '1rem',
            textDecoration: 'none',
            display: 'inline-block'
          }}>
            ➕ Добавить город
          </Link>
          <Link href="/admin/channels" style={{
            padding: '0.75rem 1.5rem',
            background: '#667eea',
            color: 'white',
            border: 'none',
            borderRadius: '6px',
            cursor: 'pointer',
            fontSize: '1rem',
            textDecoration: 'none',
            display: 'inline-block'
          }}>
            ➕ Добавить канал
          </Link>
        </div>
      </div>
    </div>
  )
}

