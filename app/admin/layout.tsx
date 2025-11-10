import { redirect } from 'next/navigation'
import { verifySession } from '@/lib/auth/session'
import { cookies } from 'next/headers'

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const cookieStore = await cookies()
  const token = cookieStore.get('admin-token')?.value

  // Для страницы логина не проверяем авторизацию
  if (typeof window === 'undefined') {
    // Server-side check
    if (!token) {
      // Проверяем, не на странице логина ли мы
      // Это будет обработано в middleware или на клиенте
    } else {
      const session = await verifySession(token)
      if (!session) {
        redirect('/admin/login')
      }
    }
  }

  return <>{children}</>
}

