import type { Metadata } from 'next'
import { probeHealth } from '@/lib/health'

export const metadata: Metadata = { title: 'Health' }
export const dynamic = 'force-dynamic'

const TONE = { ok: 'ok', warn: 'warn', fail: 'danger' } as const

/**
 * The probes run in-process rather than by fetching `/api/health` from the server. A page
 * that has to make a network call to prove it is alive fails for reasons that have nothing to
 * do with whether it is alive.
 */
export default function HealthPage() {
  const report = probeHealth()

  return (
    <>
      <section className="hero">
        <span className="eyebrow">diagnostics</span>
        <h1>Health</h1>
        <p>
          Live probes from this deployment — the same computation <code>/api/health</code> serves.
        </p>
        <div className="run-head">
          <span className="badge" data-tone={report.ok ? 'ok' : 'danger'}>
            {report.ok ? 'ok' : 'failing'}
          </span>
          <span className="badge" data-tone="ok">
            {report.version}
          </span>
        </div>
      </section>

      {!report.ok ? (
        <p className="state" data-kind="error">
          At least one probe is failing. The failing row below names the fix.
        </p>
      ) : null}

      <div className="grid">
        {report.checks.map((check) => (
          <article className="card" key={check.name}>
            <span className="badge" data-tone={TONE[check.status]}>
              {check.status}
            </span>
            <h2>{check.name}</h2>
            <p>{check.detail}</p>
            {check.fix !== undefined ? (
              <p className="reason">
                <strong>fix:</strong> {check.fix}
              </p>
            ) : null}
          </article>
        ))}
      </div>

      <p className="run-foot">
        commit {report.commit} · {report.runtime} · region {report.region}
      </p>
    </>
  )
}
