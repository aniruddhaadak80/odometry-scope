import type { EnvelopeStep } from '@/lib/runs'

/**
 * THE SIGNATURE ELEMENT.
 *
 * A drift envelope strip: one column per sample, height proportional to the observed drift,
 * with the certified bound drawn as a stepped line above it. Where the observation crosses
 * the bound the column is marked, and the first crossing is called out.
 *
 * This is a chart of the product's actual claim, not decoration. The two things a reader
 * needs to see are (a) is the observation inside the band, and (b) where does it leave. Both
 * are readable at a glance here in a way they are not on a trajectory overlay, because the
 * bound is drawn rather than implied.
 *
 * Deliberately not a gradient, not a glow, not a hero: a hatched band and a stepped line, in
 * a monospaced face, because the subject is instrument output.
 */

interface Cell {
  readonly observed: number
  readonly bound: number
  readonly exceeded: boolean
  readonly t: number
}

const CHART_HEIGHT = 132
const AXIS_HEIGHT = 18
const MIN_BAND_PX = 2

function toCells(steps: readonly EnvelopeStep[], width: number): Cell[] {
  if (steps.length === 0) return []
  // Aggregate into exactly `width` columns so the chart is a fixed size at every viewport
  // rather than stretching a 400-sample series across the page.
  const buckets = Math.min(width, steps.length)
  const cells: Cell[] = []
  for (let column = 0; column < buckets; column += 1) {
    const from = Math.floor((column * steps.length) / buckets)
    const to = Math.max(from + 1, Math.floor(((column + 1) * steps.length) / buckets))
    let observed = 0
    let bound = 0
    let exceeded = false
    for (let i = from; i < to && i < steps.length; i += 1) {
      const step = steps[i] as EnvelopeStep
      observed = Math.max(observed, step.observed)
      bound = Math.max(bound, step.bound)
      exceeded = exceeded || step.exceeded
    }
    const last = steps[Math.min(to, steps.length) - 1] as EnvelopeStep
    cells.push({ observed, bound, exceeded, t: last.t })
  }
  return cells
}

export function DriftEnvelopeStrip({
  steps,
  width = 120,
  showAxis = true,
}: {
  steps: readonly EnvelopeStep[]
  width?: number
  showAxis?: boolean
}) {
  const cells = toCells(steps, width)
  if (cells.length === 0) {
    return (
      <p className="state" data-kind="empty">
        This run has fewer than two samples, so there is no envelope to plot.
      </p>
    )
  }

  const peak = Math.max(...cells.map((cell) => Math.max(cell.observed, cell.bound)), 1e-9)
  const scale = (value: number): number =>
    Math.max(0, Math.round((value / peak) * (CHART_HEIGHT - MIN_BAND_PX)))
  const firstEscape = cells.findIndex((cell) => cell.exceeded)
  const totalSeconds = (cells[cells.length - 1] as Cell).t - (cells[0] as Cell).t

  return (
    <figure className="envelope" data-first-escape={firstEscape >= 0 ? 'yes' : 'no'}>
      <svg
        className="envelope-svg"
        viewBox={`0 0 ${cells.length} ${CHART_HEIGHT + (showAxis ? AXIS_HEIGHT : 0)}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={
          firstEscape >= 0
            ? `Drift envelope: peak observed drift ${cells.reduce((m, c) => Math.max(m, c.observed), 0).toFixed(4)} metres, first escaping the certified bound at ${(cells[firstEscape] as Cell).t.toFixed(2)} seconds.`
            : `Drift envelope: peak observed drift stays inside the certified bound for the whole run.`
        }
      >
        {/* The certified band, hatched so it reads as "allowed", not "measured". */}
        <defs>
          <pattern id="bound-hatch" width="4" height="4" patternUnits="userSpaceOnUse">
            <line x1="0" y1="4" x2="4" y2="0" stroke="var(--border-strong)" strokeWidth="1" />
          </pattern>
        </defs>
        <path
          d={cells
            .map((cell, i) => `${i === 0 ? 'M' : 'L'}${i} ${CHART_HEIGHT - scale(cell.bound)}`)
            .join(' ')}
          fill="none"
          stroke="none"
          id="band-edge"
        />
        <path
          d={
            cells
              .map((cell, i) => `${i === 0 ? 'M' : 'L'}${i} ${CHART_HEIGHT - scale(cell.bound)}`)
              .join(' ') +
            ' ' +
            [...cells]
              .reverse()
              .map((cell, i) => `L${cells.length - 1 - i} ${CHART_HEIGHT}`)
              .join(' ') +
            ' Z'
          }
          fill="url(#bound-hatch)"
          stroke="var(--border-strong)"
          strokeWidth="1"
          shapeRendering="crispEdges"
        />

        {/* Observed drift, as columns anchored to the baseline. */}
        {cells.map((cell, i) => (
          <rect
            key={i}
            x={i}
            y={CHART_HEIGHT - scale(cell.observed)}
            width={1}
            height={Math.max(scale(cell.observed), 1)}
            fill={cell.exceeded ? 'var(--danger)' : 'var(--accent)'}
          />
        ))}

        {/* The bound itself, as a stepped line so the exact crossing is readable. */}
        <polyline
          points={cells.map((cell, i) => `${i + 0.5},${CHART_HEIGHT - scale(cell.bound)}`).join(' ')}
          fill="none"
          stroke="var(--fg-muted)"
          strokeWidth="1"
          vectorEffect="non-scaling-stroke"
        />

        <line
          x1="0"
          y1={CHART_HEIGHT}
          x2={cells.length}
          y2={CHART_HEIGHT}
          stroke="var(--border-strong)"
          strokeWidth="1"
          vectorEffect="non-scaling-stroke"
        />

        {firstEscape >= 0 ? (
          <>
            <line
              x1={firstEscape + 0.5}
              y1={0}
              x2={firstEscape + 0.5}
              y2={CHART_HEIGHT}
              stroke="var(--danger)"
              strokeWidth="1"
              strokeDasharray="3 2"
              vectorEffect="non-scaling-stroke"
            />
            <text
              x={Math.min(firstEscape + 1.5, cells.length - 1)}
              y={10}
              className="envelope-marker"
              textAnchor={firstEscape > cells.length * 0.75 ? 'end' : 'start'}
            >
              first escape
            </text>
          </>
        ) : null}
      </svg>

      <figcaption className="envelope-caption">
        <span className="key">
          <span className="swatch" data-kind="observed" aria-hidden="true" />
          observed drift
        </span>
        <span className="key">
          <span className="swatch" data-kind="bound" aria-hidden="true" />
          certified bound
        </span>
        {showAxis ? (
          <span className="envelope-axis">
            0s{Number.isFinite(totalSeconds) ? ` — ${totalSeconds.toFixed(1)}s` : ''} · {cells.length} columns
          </span>
        ) : null}
      </figcaption>
    </figure>
  )
}
