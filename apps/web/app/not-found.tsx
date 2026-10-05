import Link from 'next/link'

export default function NotFound() {
  return (
    <>
      <section className="hero">
        <span className="eyebrow">404</span>
        <h1>Not found</h1>
        <p>
          That route does not exist. Every analysed run is listed in the observatory — the run identifier has
          to match one of them exactly.
        </p>
        <Link href="/">Back to the observatory →</Link>
      </section>
    </>
  )
}
