import Link from 'next/link'
import type { Metadata } from 'next'
import { DriftEnvelopeStrip } from '@/components/DriftEnvelopeStrip'
import { PRODUCT } from '@/lib/product'
import { listRuns, severityTone, toSummary } from '@/lib/runs'

export const metadata: Metadata = {
  title: `${PRODUCT.name} — observatory`,
  description: PRODUCT.tagline,
}

/**
 * The observatory: every recorded run, worst first, each with the verdict the engine
 * computed and the envelope that justifies it.
 *
 * Server-rendered on first paint. If `listRuns` throws — a malformed committed analysis — the
 * error boundary takes over rather than this page pretending there is nothing to show.
 */
export default function ObservatoryPage() {
  const analyses = listRuns()
  const runs = analyses.map(toSummary)
  const drifting = runs.filter((run) => run.severity === 'drifting').length

  return (
    <>
      <section className="hero">
        <span className="eyebrow">odometry observatory</span>
        <h1>Which sensor lied?</h1>
        <p>
          A fused pose estimate drifts. Every robotics stack can show you the drift; almost none can show you
          which sensor caused it. Odometry Scope re-integrates the pose with each sensor ablated in turn, and
          reports how much of the drift that sensor explained.
        </p>
        <div className="command-bar">
          <code>odoscope run apps/web/data/runs/wheel-scale-drift.json</code>
        </div>
      </section>

      <section aria-labelledby="runs-heading">
        <div className="section-head">
          <h2 id="runs-heading">Recorded runs</h2>
          {runs.length > 0 ? (
            <p className="section-meta">
              {runs.length} run{runs.length === 1 ? '' : 's'} · {drifting} drifting
            </p>
          ) : null}
        </div>

        {runs.length === 0 ? (
          <p className="state" data-kind="empty">
            No analyses are committed yet. Run <code>python scripts/generate-runs.py</code> at the repository
            root to build the sample runs and their engine output.
          </p>
        ) : (
          <div className="grid">
            {runs.map((run) => {
              const analysis = analyses.find((candidate) => candidate.id === run.id)
              return (
                <article className="card run-card" key={run.id}>
                  <header className="run-head">
                    <span className="badge" data-tone={severityTone(run.severity)}>
                      {run.severity}
                    </span>
                    <span className="badge" data-tone={run.confidence === 'certified' ? 'ok' : 'warn'}>
                      {run.confidence}
                    </span>
                  </header>

                  <h3>
                    <Link href={`/runs/${run.id}`}>{run.name}</Link>
                  </h3>
                  <p>{run.summary}</p>

                  {analysis ? (
                    <DriftEnvelopeStrip steps={analysis.steps} width={140} showAxis={false} />
                  ) : null}

                  <dl className="figures">
                    <div>
                      <dt>peak drift</dt>
                      <dd>{run.maxObserved.toFixed(4)} m</dd>
                    </div>
                    <div>
                      <dt>bound</dt>
                      <dd>{run.maxBound.toFixed(4)} m</dd>
                    </div>
                    <div>
                      <dt>ratio</dt>
                      <dd>{run.boundRatio.toFixed(2)}×</dd>
                    </div>
                    <div>
                      <dt>verdict on</dt>
                      <dd>{run.dominantSensor ?? '—'}</dd>
                    </div>
                  </dl>

                  <p className="run-foot">
                    {run.sampleCount} samples · {run.durationS.toFixed(1)}s · {run.rateHz.toFixed(1)} Hz ·{' '}
                    {run.pathLength.toFixed(2)} m path
                  </p>
                </article>
              )
            })}
          </div>
        )}
      </section>

      <section aria-labelledby="how-heading">
        <div className="section-head">
          <h2 id="how-heading">Why this is not a plot comparison</h2>
        </div>
        <div className="grid">
          <article className="card">
            <h3>The bound is certified, not chosen</h3>
            <p>
              Each step injects the rate uncertainty you state, then accumulates it as a random walk. A
              worst-case bound would compound exponentially and grow so wide it could never detect anything.
            </p>
          </article>
          <article className="card">
            <h3>Bias escapes; noise does not</h3>
            <p>
              Independent sensor noise grows like √t and stays inside the envelope. A systematic scale factor
              grows like t, so it leaves almost immediately. That difference is the signal.
            </p>
          </article>
          <article className="card">
            <h3>It refuses to round up</h3>
            <p>
              When drift leaves the envelope the verdict is <code>unbounded</code>, not &ldquo;probably
              fine&rdquo;. Under <code>--strict</code> the engine raises
              <code> BOUND_VIOLATION</code> instead of returning an answer.
            </p>
          </article>
        </div>
      </section>
    </>
  )
}
