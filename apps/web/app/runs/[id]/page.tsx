import Link from 'next/link'
import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { DriftEnvelopeStrip } from '@/components/DriftEnvelopeStrip'
import { PRODUCT } from '@/lib/product'
import { getRun, listRuns, severityTone } from '@/lib/runs'

interface PageProps {
  params: Promise<{ id: string }>
}

export function generateStaticParams() {
  return listRuns().map((analysis) => ({ id: analysis.id }))
}

/**
 * The set of valid run ids is closed. Without this, Next treats an unknown id as a
 * dynamic route, renders the not-found boundary for it, and still answers 200 — which tells a
 * monitoring system and a crawler's user agent that the page exists. It does not.
 */
export const dynamicParams = false

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params
  const analysis = getRun(id)
  return {
    title: analysis ? `${analysis.name} — ${PRODUCT.name}` : `Unknown run — ${PRODUCT.name}`,
    description: analysis?.summary ?? 'A recorded run that is not in the observatory.',
  }
}

export default async function RunPage({ params }: PageProps) {
  const { id } = await params
  const analysis = getRun(id)
  // A real not-found, distinct from the empty state and from an error.
  if (!analysis) notFound()

  const escaped = analysis.steps.filter((step) => step.exceeded).length

  return (
    <>
      <section className="hero">
        <span className="eyebrow">
          <Link href="/">observatory</Link> / {analysis.id}
        </span>
        <h1>{analysis.name}</h1>
        <p>{analysis.summary}</p>
        <div className="run-head">
          <span className="badge" data-tone={severityTone(analysis.verdict.severity)}>
            {analysis.verdict.severity}
          </span>
          <span className="badge" data-tone={analysis.verdict.confidence === 'certified' ? 'ok' : 'warn'}>
            {analysis.verdict.confidence}
          </span>
        </div>
      </section>

      <section aria-labelledby="verdict-heading">
        <div className="section-head">
          <h2 id="verdict-heading">Verdict</h2>
        </div>
        <div className="card">
          <p className="verdict-line">{analysis.verdict.summary}</p>
          <dl className="figures">
            <div>
              <dt>peak observed</dt>
              <dd>{analysis.maxObserved.toFixed(4)} m</dd>
            </div>
            <div>
              <dt>certified bound</dt>
              <dd>{analysis.maxBound.toFixed(4)} m</dd>
            </div>
            <div>
              <dt>ratio</dt>
              <dd>{analysis.boundRatio.toFixed(2)}×</dd>
            </div>
            <div>
              <dt>rms drift</dt>
              <dd>{analysis.rmsObserved.toFixed(4)} m</dd>
            </div>
            <div>
              <dt>max heading error</dt>
              <dd>{analysis.maxHeadingError.toFixed(4)} rad</dd>
            </div>
            <div>
              <dt>baseline drift</dt>
              <dd>{analysis.baselineDrift.toFixed(4)} m</dd>
            </div>
          </dl>
        </div>
      </section>

      <section aria-labelledby="envelope-heading">
        <div className="section-head">
          <h2 id="envelope-heading">Drift envelope</h2>
          <p className="section-meta">
            {analysis.steps.length} steps · {escaped} outside the bound
            {analysis.truncated ? ' (truncated)' : ''}
          </p>
        </div>
        <div className="card">
          <DriftEnvelopeStrip steps={analysis.steps} width={220} />
        </div>
      </section>

      <section aria-labelledby="ablation-heading">
        <div className="section-head">
          <h2 id="ablation-heading">Sensor ablation</h2>
          <p className="section-meta">fusion inconsistency {analysis.fusionInconsistency.toExponential(2)}</p>
        </div>
        <div className="card table-card">
          <table>
            <thead>
              <tr>
                <th scope="col">sensor</th>
                <th scope="col">drift without it</th>
                <th scope="col">explained</th>
                <th scope="col">verdict</th>
              </tr>
            </thead>
            <tbody>
              {analysis.attribution.map((entry) => (
                <tr key={entry.sensor} data-dominant={entry.sensor === analysis.dominantSensor}>
                  <th scope="row">
                    {entry.sensor}
                    {entry.sensor === analysis.dominantSensor ? <span className="tag">named</span> : null}
                  </th>
                  <td>{entry.driftWithout.toFixed(4)} m</td>
                  <td>{(entry.explainedFraction * 100).toFixed(1)}%</td>
                  <td>
                    <span
                      className="badge"
                      data-tone={
                        entry.verdict === 'primary' ? 'danger' : entry.verdict === 'masking' ? 'warn' : 'ok'
                      }
                    >
                      {entry.verdict}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="notes-heading">
        <div className="section-head">
          <h2 id="notes-heading">How this run was built</h2>
        </div>
        <div className="card">
          {analysis.notes.length === 0 ? (
            <p className="state" data-kind="empty">
              No notes were recorded for this run.
            </p>
          ) : (
            <ul className="notes">
              {analysis.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          )}
          <p className="run-foot">
            {analysis.sampleCount} samples · {analysis.durationS.toFixed(1)}s · {analysis.rateHz.toFixed(1)}{' '}
            Hz · {analysis.pathLength.toFixed(2)} m path
          </p>
        </div>
      </section>
    </>
  )
}
