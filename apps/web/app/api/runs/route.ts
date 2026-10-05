import { NextResponse } from 'next/server'
import { listRuns, severityTone, toSummary } from '@/lib/runs'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * The observatory as JSON: one summary per committed run, worst drift first. The full
 * per-step envelope is deliberately not included here — it is large, and `/api/runs/[id]`
 * is the route that serves it.
 */
export function GET() {
  const summaries = listRuns().map(toSummary)
  return NextResponse.json(
    {
      count: summaries.length,
      drifting: summaries.filter((run) => severityTone(run.severity) === 'danger').length,
      runs: summaries,
    },
    { headers: { 'cache-control': 'public, max-age=60' } },
  )
}
