'use client'

import { useEffect } from 'react'

/**
 * The error state, and it is deliberately unlike the empty state.
 *
 * Empty means "there is genuinely nothing here". Error means "this should have rendered and
 * did not", so it names the cause, offers a retry, and says which layer failed — a malformed
 * committed analysis is a different problem from a dead upstream.
 */
export default function Error({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => {
    // Diagnostics belong in the console, never in the rendered message: a stack trace is not
    // a user-facing explanation.
    console.error('observatory route failed', error)
  }, [error])

  const isDataProblem = /analysis|steps|verdict|data\/runs/i.test(error.message)

  return (
    <section className="hero">
      <span className="eyebrow">error</span>
      <h1>This run could not be rendered</h1>
      <p className="state" data-kind="error">
        {error.message || 'An unknown error occurred while loading the run data.'}
      </p>
      <p>
        {isDataProblem
          ? 'The failure came from the data layer: a committed analysis under apps/web/data/runs is missing a required field or is not valid JSON.'
          : 'The failure came from the application layer rather than the run data.'}
      </p>
      <p>
        Regenerating the sample runs fixes a data-layer failure: <code>python scripts/generate-runs.py</code>
      </p>
      <button type="button" onClick={reset}>
        Try again
      </button>
    </section>
  )
}
