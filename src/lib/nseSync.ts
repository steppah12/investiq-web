// @ts-nocheck
import { supabaseAdmin } from '@/lib/supabase/client'
import { db } from '@/lib/database'
import { scrapeMyStocksQuote } from '@/lib/scraper/mystocks'

// Maps InvestIQ's internal stock name (used as the iq_stock_<name> key,
// must match STOCK_KEY() in InvestIQApp.tsx) to the ticker symbol
// live.mystocks.co.ke actually uses for that stock.
//
// NOTE: InvestIQApp.tsx's own LAB_TICKERS maps "Crown Paints" -> "BERG"
// (its legacy ticker), but live.mystocks.co.ke lists it under "CRWN" —
// scraping with BERG returns nothing. Fixed here; the stored stock *name*
// is unchanged so it still lines up with existing iq_stock_/iq_weights_/
// iq_lhist_ rows.
export const TRACKED_STOCKS: Record<string, string> = {
  'Stanbic Bank': 'SBIC',
  'Co-op Bank': 'COOP',
  'Kenya Re': 'KNRE',
  'ABSA NewGold ETF': 'GLD',
  'Crown Paints': 'CRWN',
}

// Possible per-stock outcomes of a sync attempt. Kept as plain strings
// (not an enum) so they show up readably in Supabase logs and JSON
// responses without any decoding.
export type SyncStatus =
  | 'updated' // new EOD close appended to the training dataset
  | 'no_new_data' // scraped OK, but it's the same trading day already stored
  | 'market_not_closed' // scraped OK, but price isn't a final EOD close yet — not written to training data
  | 'weekend_skip' // NSE doesn't trade Sat/Sun — no network call made
  | 'error'

function isNairobiWeekend(): boolean {
  // NSE trading days are Mon–Fri. Africa/Nairobi is UTC+3 with no DST.
  const nairobiNow = new Date(Date.now() + 3 * 60 * 60 * 1000)
  const day = nairobiNow.getUTCDay() // getUTCDay on a shifted timestamp == the Nairobi weekday
  return day === 0 || day === 6
}

async function archiveSnapshot(stockName: string, ticker: string, quote: any) {
  if (!supabaseAdmin) return
  // Insert-only, permanent record of every scrape attempt — this table is
  // never updated or deleted, so even if the working kv dataset is ever
  // corrupted, every day's close can be rebuilt from here.
  await supabaseAdmin.from('daily_price_archive').insert({
    stock_name: stockName,
    ticker,
    trade_date: quote.date,
    open: quote.open,
    high: quote.high,
    low: quote.low,
    close: quote.close,
    volume: quote.volume,
    market_status: quote.marketStatus,
    raw_blob: { raw: quote.raw },
  })
}

async function logFetch(ticker: string, date: string, status: string, extra: Record<string, any> = {}) {
  if (!supabaseAdmin) return
  await supabaseAdmin.from('nse_fetch_log').insert({
    stock_ticker: ticker,
    fetch_date: date,
    status,
    ...extra,
  })
}

export async function fetchAndStoreStock(
  stockName: string,
  ticker: string
): Promise<{ status: SyncStatus; stockName: string; ticker: string; [k: string]: any }> {
  if (isNairobiWeekend()) {
    return { status: 'weekend_skip', stockName, ticker }
  }

  const quote = await scrapeMyStocksQuote(ticker)

  // Every successful scrape gets archived permanently, regardless of what
  // happens next — this is the "even if something happens we can still
  // retrieve all datasets" guarantee.
  await archiveSnapshot(stockName, ticker, quote)

  // Only a genuine end-of-day close is safe to feed into the training
  // dataset. If the site is showing a live/partial intraday print (e.g.
  // this got triggered manually mid-session), don't let it into the model's
  // data — it would look like a real close but isn't final.
  if (quote.marketStatus !== 'closed') {
    await logFetch(ticker, quote.date, 'MARKET_NOT_CLOSED', {
      price_data: { close: quote.close, marketStatus: quote.marketStatus },
    })
    return { status: 'market_not_closed', stockName, ticker, marketStatus: quote.marketStatus, date: quote.date }
  }

  const key = `iq_stock_${stockName.replace(/\s+/g, '_')}`
  const existing = await db.load(key, { name: stockName, rows: [] })
  const rows = Array.isArray(existing?.rows) ? [...existing.rows] : []

  const newRow = {
    date: quote.date,
    open: quote.open,
    high: quote.high,
    low: quote.low,
    close: quote.close,
    volume: quote.volume,
  }

  const idx = rows.findIndex((r: any) => r.date === newRow.date)
  const alreadyHadThisDate = idx >= 0

  if (alreadyHadThisDate) {
    rows[idx] = newRow // re-running same day overwrites, doesn't duplicate
  } else {
    rows.push(newRow)
  }
  rows.sort((a: any, b: any) => String(a.date).localeCompare(String(b.date)))

  await db.save(key, {
    name: stockName,
    rows,
    _lastUpdated: new Date().toISOString(),
  })

  await logFetch(ticker, newRow.date, alreadyHadThisDate ? 'NO_NEW_DATA' : 'SUCCESS', {
    price_data: newRow,
  })

  return {
    status: alreadyHadThisDate ? 'no_new_data' : 'updated',
    stockName,
    ticker,
    ...newRow,
    totalRowsStored: rows.length,
  }
}

// Fetches every tracked stock, one at a time, with a polite delay between
// requests. Returns a per-stock status array — never throws, so a failure
// on one stock doesn't stop the rest from updating.
export async function fetchAndStoreAllTrackedStocks() {
  const results = []

  if (isNairobiWeekend()) {
    // Skip all 5 in one shot — no point making 5 network calls just to find
    // out the market's closed for the weekend on every one of them.
    for (const [stockName, ticker] of Object.entries(TRACKED_STOCKS)) {
      results.push({ status: 'weekend_skip', stockName, ticker })
    }
    return results
  }

  for (const [stockName, ticker] of Object.entries(TRACKED_STOCKS)) {
    try {
      const result = await fetchAndStoreStock(stockName, ticker)
      results.push(result)
    } catch (error) {
      console.error(`Failed to fetch ${stockName} (${ticker}):`, error)
      const errMsg = error instanceof Error ? error.message : 'Unknown error'
      results.push({ status: 'error', stockName, ticker, error: errMsg })
      await logFetch(ticker, new Date().toISOString().split('T')[0], 'ERROR', { error_message: errMsg })
    }
    // Be polite to myStocks' servers — don't hammer them.
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }
  return results
}
