// @ts-nocheck
// Scrapes live end-of-day quotes from live.mystocks.co.ke for NSE-listed
// stocks. The page embeds a small JSON blob in its HTML with the current
// quote — we pull that out with a regex rather than needing a headless
// browser (the site is server-rendered, no JS execution required).
//
// Example blob found in the page:
// {"reload":0,"stamp":1789129511,"track":65742232,"time":"3:25 PM EAT",
//  "update":0,"klass":"c1","market":"closed",
//  "data":["94.00","0.25 (0.27%)","94.25","94.00","94.00","95.00","93.50",
//           "375,298","35.25M","1,275","302.05B","3:25 PM EAT", ...]}
//
// data[] positions (reverse-engineered from the page's own labeled table):
//   0 = last/close   5 = high   6 = low   7 = volume

const MYSTOCKS_BASE = 'https://live.mystocks.co.ke/stock='

export interface ScrapedQuote {
  ticker: string
  date: string // YYYY-MM-DD
  close: number
  high: number
  low: number
  volume: number
  open: number // not reliably available from this blob — set equal to close
  marketStatus: string // "closed" = final EOD price, anything else = live/partial
  raw: string // original matched JSON blob, kept for debugging
}

function parseNumber(s: string | undefined): number {
  if (!s) return NaN
  return parseFloat(s.replace(/,/g, ''))
}

// Converts "End of day - Sep 11, 2026" -> "2026-09-11".
// Falls back to today's date (Africa/Nairobi) if the page doesn't show an
// explicit "End of day" date (e.g. market is live/open when scraped).
function extractTradeDate(html: string): string {
  const m = html.match(/End of day\s*-\s*([A-Za-z]+\s+\d{1,2},\s*\d{4})/)
  if (m) {
    const d = new Date(m[1])
    if (!isNaN(d.getTime())) {
      return d.toISOString().split('T')[0]
    }
  }
  // Fallback: "today" in EAT (UTC+3)
  const now = new Date(Date.now() + 3 * 60 * 60 * 1000)
  return now.toISOString().split('T')[0]
}

export async function scrapeMyStocksQuote(ticker: string): Promise<ScrapedQuote> {
  const url = `${MYSTOCKS_BASE}${encodeURIComponent(ticker)}`
  const res = await fetch(url, {
    headers: {
      // A plain fetch without a UA sometimes gets a stripped-down page from
      // this site — a normal browser UA gets the full page reliably.
      'User-Agent':
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    },
    // Always hit origin fresh — this is a daily cron job, not a page the
    // user is browsing, so there's nothing to cache.
    cache: 'no-store',
  })

  if (!res.ok) {
    throw new Error(`myStocks fetch failed for ${ticker}: HTTP ${res.status}`)
  }

  const html = await res.text()

  const blobMatch = html.match(/\{"reload":\d+,"stamp":\d+,"track":\d+,"time":"[^"]*","update":\d+,"klass":"[^"]*","market":"[^"]*","data":\[[^\]]*\]\}/)
  if (!blobMatch) {
    throw new Error(`myStocks: quote blob not found for ${ticker} — page layout may have changed`)
  }

  let blob: any
  try {
    blob = JSON.parse(blobMatch[0])
  } catch (e) {
    throw new Error(`myStocks: failed to parse quote blob for ${ticker}: ${e}`)
  }

  const d: string[] = blob.data
  if (!Array.isArray(d) || d.length < 8) {
    throw new Error(`myStocks: unexpected data shape for ${ticker}`)
  }

  const close = parseNumber(d[0])
  const high = parseNumber(d[5])
  const low = parseNumber(d[6])
  const volume = parseNumber(d[7])

  if ([close, high, low, volume].some((n) => isNaN(n))) {
    throw new Error(`myStocks: could not parse numeric fields for ${ticker} (raw: ${blobMatch[0]})`)
  }

  return {
    ticker,
    date: extractTradeDate(html),
    close,
    high,
    low,
    volume,
    open: close, // no reliable open in this blob — see note above
    marketStatus: blob.market || 'unknown',
    raw: blobMatch[0],
  }
}
