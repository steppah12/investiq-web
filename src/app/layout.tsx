import './globals.css'
import type { Metadata } from 'next'
import { Inter } from 'next/font/google'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'InvestIQ - NSE ML Investment Platform',
  description: 'Machine Learning Investment Analysis Platform for Nairobi Securities Exchange (NSE)',
  keywords: ['NSE', 'Kenya', 'stocks', 'machine learning', 'investment', 'analysis'],
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className="dark">
      <body className={inter.className}>
        <div className="min-h-screen bg-slate-950 text-slate-50">
          {children}
        </div>
      </body>
    </html>
  )
}