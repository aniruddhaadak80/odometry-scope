import type { Metadata, Viewport } from 'next'
import Link from 'next/link'
import { PRODUCT } from '@/lib/product'
import './globals.css'

export const metadata: Metadata = {
  title: PRODUCT.name,
  description: PRODUCT.tagline,
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <div className="shell">
          <header className="site-header">
            <div className="container">
              <Link href="/" className="brand">
                {PRODUCT.name}
              </Link>
              <nav className="site-nav" aria-label="Main">
                <Link href="/">Observatory</Link>
                <Link href="/surfaces">Surfaces</Link>
                <Link href="/api/health">Health</Link>
              </nav>
            </div>
          </header>

          <main>
            <div className="container">{children}</div>
          </main>

          <footer className="site-footer">
            <div className="container">
              <span>
                {PRODUCT.name} v{PRODUCT.version} — Apache-2.0. Deterministic core, extensible surface.
              </span>
            </div>
          </footer>
        </div>
      </body>
    </html>
  )
}
