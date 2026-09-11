'use client'
import dynamic from 'next/dynamic'

const InvestIQApp = dynamic(() => import('./InvestIQApp'), { ssr: false })

export default function Page() {
  return <InvestIQApp />
}
