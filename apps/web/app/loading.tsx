export default function Loading() {
  return (
    <section aria-busy="true" aria-live="polite">
      <div className="hero">
        <div className="skeleton" style={{ width: '6rem', height: '0.75rem' }} />
        <div className="skeleton" style={{ width: '20rem', height: '2.25rem' }} />
        <div className="skeleton" style={{ width: '28rem', height: '1.125rem' }} />
      </div>
      <div className="grid">
        {[0, 1, 2].map((index) => (
          <div className="card" key={index}>
            <div className="skeleton" style={{ width: '4rem' }} />
            <div className="skeleton" style={{ width: '70%', height: '1.25rem' }} />
            <div className="skeleton" style={{ width: '100%' }} />
          </div>
        ))}
      </div>
    </section>
  )
}
