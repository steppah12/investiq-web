// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { TRACKED_STOCKS, fetchAndStoreStock, fetchAndStoreAllTrackedStocks } from '@/lib/nseSync'
import { runFullRosterCatchupAndRotation } from '@/lib/liveLab/pipeline'

// Same auth as /api/cron/daily-update — this endpoint does real work
// (outbound scrapes + Supabase writes) and had no auth at all before,
// meaning anyone who found the URL could trigger it repeatedly on demand.
function isAuthorized(request: NextRequest): boolean {
  const authHeader = request.headers.get('authorization')
  const secret = process.env.CRON_SECRET
  if (!secret) return false // no fallback string — missing env var means "deny", not "dev-secret"
  return authHeader === `Bearer ${secret}`
}

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const { searchParams } = new URL(request.url)
    const tickerParam = searchParams.get('ticker')
    const nameParam = searchParams.get('name')
    const runRoster = searchParams.get('runRoster')

    // Phase C — manual trigger only, not part of the daily cron yet.
    // Catches up every trained stock (not just the original 5) and runs
    // promotion/relegation. Safe to run repeatedly; each stock only
    // processes dates it hasn't already got a journal entry for.
    if (runRoster === 'true') {
      const result = await runFullRosterCatchupAndRotation()
      return NextResponse.json({ success: !result.error, ...result })
    }

    if (nameParam) {
      const ticker = TRACKED_STOCKS[nameParam]
      if (!ticker) {
        return NextResponse.json({ error: `Unknown stock name: ${nameParam}` }, { status: 400 })
      }
      const result = await fetchAndStoreStock(nameParam, ticker)
      return NextResponse.json({ success: true, result })
    }

    if (tickerParam) {
      const entry = Object.entries(TRACKED_STOCKS).find(([, t]) => t === tickerParam)
      if (!entry) {
        return NextResponse.json({ error: `Unknown ticker: ${tickerParam}` }, { status: 400 })
      }
      const result = await fetchAndStoreStock(entry[0], entry[1])
      return NextResponse.json({ success: true, result })
    }

    // No params — fetch everything InvestIQ tracks (+ runs Live Lab catch-up if new data landed)
    const result = await fetchAndStoreAllTrackedStocks()
    return NextResponse.json({ success: true, ...result, timestamp: new Date().toISOString() })
  } catch (error) {
    console.error('NSE fetch error:', error)
    return NextResponse.json({ error: 'Failed to fetch NSE data' }, { status: 500 })
  }
}

// POST endpoint for manual single-stock refresh from the UI, e.g.
// fetch('/api/nse/fetch', { method: 'POST', body: JSON.stringify({ name: 'Stanbic Bank' }) })
export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const { name, ticker } = await request.json()

    const stockName = name || Object.entries(TRACKED_STOCKS).find(([, t]) => t === ticker)?.[0]
    const resolvedTicker = ticker || TRACKED_STOCKS[name]

    if (!stockName || !resolvedTicker) {
      return NextResponse.json({ error: 'Provide a known stock name or ticker' }, { status: 400 })
    }

    const result = await fetchAndStoreStock(stockName, resolvedTicker)
    return NextResponse.json({ success: true, message: `Updated ${stockName}`, result })
  } catch (error) {
    console.error('Manual NSE fetch error:', error)
    return NextResponse.json({ error: 'Failed to update NSE data' }, { status: 500 })
  }
}
