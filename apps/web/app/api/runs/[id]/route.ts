import { NextResponse } from 'next/server'
import { getRun } from '@/lib/runs'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

interface RouteProps {
  params: Promise<{ id: string }>
}

/** The full analysis for one run, envelope included. 404 is a real answer, not a fallback. */
export async function GET(_request: Request, { params }: RouteProps) {
  const { id } = await params
  const analysis = getRun(id)
  if (!analysis) {
    return NextResponse.json({ error: 'NOT_FOUND', message: `no run named "${id}"` }, { status: 404 })
  }
  return NextResponse.json(analysis, { headers: { 'cache-control': 'public, max-age=60' } })
}
