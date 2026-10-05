import { NextResponse } from 'next/server'
import { probeHealth } from '@/lib/health'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const startedAt = Date.now()

export function GET() {
  const report = probeHealth()
  return NextResponse.json(
    { ...report, uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) },
    { status: report.ok ? 200 : 503, headers: { 'cache-control': 'no-store' } },
  )
}
