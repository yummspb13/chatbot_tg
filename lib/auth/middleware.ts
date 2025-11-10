import { NextRequest, NextResponse } from 'next/server'
import { verifySession } from './session'

export async function requireAuth(req: NextRequest): Promise<NextResponse | null> {
  const token = req.cookies.get('admin-token')?.value

  if (!token) {
    return NextResponse.redirect(new URL('/admin/login', req.url))
  }

  const session = await verifySession(token)

  if (!session) {
    const response = NextResponse.redirect(new URL('/admin/login', req.url))
    response.cookies.delete('admin-token')
    return response
  }

  return null
}

