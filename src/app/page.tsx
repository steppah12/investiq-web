'use client'
import dynamic from 'next/dynamic'
import { useEffect, useState } from 'react'
import { hydrateLocalStorageFromSupabase, hasPendingWrites, didHydrationFail } from '@/lib/localSync'

const InvestIQApp = dynamic(() => import('./InvestIQApp'), { ssr: false })

export default function Page() {
  const [ready, setReady] = useState(false)
  const [hydrationError, setHydrationError] = useState(false)

  useEffect(() => {
    hydrateLocalStorageFromSupabase().finally(() => {
      setHydrationError(didHydrationFail())
      setReady(true)
    })
  }, [])

  // Warn before the user can lose an in-flight write by closing/navigating
  // away too fast (e.g., right after finishing a retrain) — the mirror to
  // Supabase is deliberately fire-and-forget for speed, so this is the
  // one safeguard against that turning into silent data loss.
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (hasPendingWrites()) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [])

  if (!ready) {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#9ca3af',
          fontFamily: 'sans-serif',
          fontSize: 14,
        }}
      >
        Loading your data…
      </div>
    )
  }

  return (
    <>
      {hydrationError && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            zIndex: 9999,
            background: '#7f1d1d',
            color: '#fecaca',
            fontFamily: 'sans-serif',
            fontSize: 13,
            padding: '8px 16px',
            textAlign: 'center',
          }}
        >
          Couldn't reach the database to load your latest data — showing whatever's saved on this
          device, which may be out of date. Refresh to try again.
        </div>
      )}
      <InvestIQApp />
    </>
  )
}
