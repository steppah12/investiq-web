// @ts-nocheck
// Scrapes live end-of-day quotes from live.mystocks.co.ke for NSE-listed
// stocks.
//
// CORRECTED 2026-09-24: the site began HTML-entity-encoding the embedded
// {"reload":...,"data":[...]} JSON blob (&quot; instead of ") sometime
// around 2026-09-16, breaking the old regex match outright. Worse: even
// once decoded, the data[] array's positions no longer match what this
// file's old comment claimed (index 6 is now previous-close, not low;
// index 7 is some other stat, not volume) — confirmed by cross-checking
// a real page against its own visibly labeled summary box.
//
// Rather than trust another fragile numbered array, this now parses the
// labeled elements directly from the static "End of Day" summary box that
// EVERY visitor sees without logging in (confirmed via a real fetch,
// 2026-09-24): id=rtPrice2 (last/close), id=rtHi (high), id=rtLo (low),
// id=rtVol (volume), id=rtPrev (previous close), id=rtTime2 (contains the
// "End of day - <date>" label used for both the trade date and to confirm
// this is a final close, not a live intraday print).
//
// The old JSON blob is still used for ONE thing: its "market" field
// ("open"/"closed"), since that's the one signal not duplicated anywhere
// in the static box. It still needs entity-decoding to read.

const MYSTOCKS_BASE = 'https://live.mystocks.co.ke/stock='

export interface ScrapedQuote {
  ticker: string
  date: string // YYYY-MM-DD
  close: number
  high: number
  low: number
  volume: number
  open: number // not reliably available on this page — set equal to close
  marketStatus: string // "closed" = final EOD price, anything else = live/partial
  raw: string // the relevant HTML snippet, kept for debugging
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
  const now = new Date(Date.now() + 3 * 60 * 60 * 1000)
  return now.toISOString().split('T')[0]
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
}

function extractMarketStatus(html: string): string {
  const blobMatch = html.match(/id=rtDataJson[^>]*>(\{.*?\})<\/div>/s)
  if (!blobMatch) return 'unknown'
  const decoded = decodeHtmlEntities(blobMatch[1])
  const marketMatch = decoded.match(/"market":"([^"]*)"/)
  return marketMatch ? marketMatch[1] : 'unknown'
}

function extractById(html: string, id: string): string | undefined {
  // Matches id=rtHi>60.00</b> or id="rtHi">60.00</b> — the page uses
  // unquoted attributes throughout, so allow both forms.
  const m = html.match(new RegExp('id=["\']?' + id + '["\']?>([^<]*)<'))
  return m ? m[1].trim() : undefined
}

export async function scrapeMyStocksQuote(ticker: string): Promise<ScrapedQuote> {
  const url = MYSTOCKS_BASE + encodeURIComponent(ticker)
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      Referer: 'https://live.mystocks.co.ke/',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'same-origin',
    },
    cache: 'no-store',
  })

  if (!res.ok) {
    throw new Error('myStocks fetch failed for ' + ticker + ': HTTP ' + res.status)
  }

  const html = await res.text()

  const closeStr = extractById(html, 'rtPrice2')
  const highStr = extractById(html, 'rtHi')
  const lowStr = extractById(html, 'rtLo')
  const volStr = extractById(html, 'rtVol')

  if (!closeStr || !highStr || !lowStr || !volStr) {
    const missing = [
      !closeStr && 'rtPrice2 (close)',
      !highStr && 'rtHi (high)',
      !lowStr && 'rtLo (low)',
      !volStr && 'rtVol (volume)',
    ].filter(Boolean).join(', ')
    const nameIdx = html.indexOf('id=stkName')
    const context = nameIdx === -1 ? '(id=stkName not found either — page structure may have changed again)' : html.slice(nameIdx, nameIdx + 400)
    throw new Error(
      'myStocks: could not find expected field(s) for ' + ticker + ': ' + missing + '. HTTP ' + res.status + ', response length ' + html.length + ' chars. Context: ' + context
    )
  }

  const close = parseNumber(closeStr)
  const high = parseNumber(highStr)
  const low = parseNumber(lowStr)
  const volume = parseNumber(volStr)

  if ([close, high, low, volume].some((n) => isNaN(n))) {
    throw new Error(
      'myStocks: could not parse numeric fields for ' + ticker + ' (raw: close="' + closeStr + '" high="' + highStr + '" low="' + lowStr + '" vol="' + volStr + '")'
    )
  }

  return {
    ticker,
    date: extractTradeDate(html),
    close,
    high,
    low,
    volume,
    open: close, // no reliable separate "open" field on this page
    marketStatus: extractMarketStatus(html),
    raw: 'close=' + closeStr + ' high=' + highStr + ' low=' + lowStr + ' vol=' + volStr,
  }
}
