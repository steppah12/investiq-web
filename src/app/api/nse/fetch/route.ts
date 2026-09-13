// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { TRACKED_STOCKS, fetchAndStoreStock, fetchAndStoreAllTrackedStocks } from '@/lib/nseSync'

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const tickerParam = searchParams.get('ticker')
    const nameParam = searchParams.get('name')

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
