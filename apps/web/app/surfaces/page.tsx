import type { Metadata } from 'next'
import { SURFACES } from '@/lib/product'

export const metadata: Metadata = { title: 'Surfaces' }

/**
 * What ships, and what deliberately does not. Every omission carries the reason it was
 * chosen — an omission with no stated reason is indistinguishable from unfinished work.
 */
export default function SurfacesPage() {
  const shipped = SURFACES.filter((surface) => surface.status === 'shipped')
  const omitted = SURFACES.filter((surface) => surface.status === 'omitted')

  return (
    <>
      <section className="hero">
        <span className="eyebrow">capability</span>
        <h1>Surfaces</h1>
        <p>
          Every capability in this product is a Tool in one registry, reachable identically from each surface
          below. A surface is a transport, never a second implementation.
        </p>
      </section>

      <section aria-labelledby="shipped-heading">
        <div className="section-head">
          <h2 id="shipped-heading">Shipped</h2>
          <p className="section-meta">{shipped.length} surfaces</p>
        </div>
        {shipped.length === 0 ? (
          <p className="state" data-kind="empty">
            No surfaces are registered yet.
          </p>
        ) : (
          <div className="grid">
            {shipped.map((surface) => (
              <article className="card" key={surface.id}>
                <span className="badge" data-tone="ok">
                  shipped
                </span>
                <h3>{surface.title}</h3>
                <p>{surface.summary}</p>
                <code className="surface-id">{surface.id}</code>
              </article>
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="omitted-heading">
        <div className="section-head">
          <h2 id="omitted-heading">Deliberately omitted</h2>
          <p className="section-meta">{omitted.length} surfaces</p>
        </div>
        {omitted.length === 0 ? (
          <p className="state" data-kind="empty">
            Nothing was omitted.
          </p>
        ) : (
          <div className="grid">
            {omitted.map((surface) => (
              <article className="card omitted" key={surface.id}>
                <span className="badge" data-tone="warn">
                  omitted
                </span>
                <h3>{surface.title}</h3>
                <p>{surface.summary}</p>
                {surface.reason ? (
                  <p className="reason">
                    <strong>Why:</strong> {surface.reason}
                  </p>
                ) : null}
              </article>
            ))}
          </div>
        )}
      </section>
    </>
  )
}
