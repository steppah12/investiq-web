'use client'
import dynamic from 'next/dynamic'
import { useEffect, useState } from 'react'
import { hydrateLocalStorageFromSupabase } from '@/lib/localSync'

const InvestIQApp = dynamic(() => import('./InvestIQApp'), { ssr: false })

export default function Page() {
  const [ready, setReady] = useState(false)

  useEffect(() => {
    hydrateLocalStorageFromSupabase().finally(() => setReady(true))
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

  return <InvestIQApp />
}
