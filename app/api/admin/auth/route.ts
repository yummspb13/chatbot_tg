import { NextRequest, NextResponse } from 'next/server'
import { verifySession } from '@/lib/auth/session'

export async function GET(req: NextRequest) {
  try {
    const token = req.cookies.get('admin-token')?.value

    if (!token) {
      return NextResponse.json({ authenticated: false }, { status: 401 })
    }

    const session = await verifySession(token)

    if (!session) {
      return NextResponse.json({ authenticated: false }, { status: 401 })
    }

    return NextResponse.json({ authenticated: true, username: session.username })
  } catch (error) {
    return NextResponse.json({ authenticated: false }, { status: 401 })
  }
}

export async function POST(req: NextRequest) {
  // Logout
  const response = NextResponse.json({ success: true })
  response.cookies.delete('admin-token')
  return response
}

