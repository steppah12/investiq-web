// @ts-nocheck
// Scrapes live end-of-day quotes from live.mystocks.co.ke for NSE-listed
// stocks.
//
// CORRECTED 2026-09-24 (first pass): the site began HTML-entity-encoding
// the embedded JSON blob (&quot; instead of ") and reshuffled its data[]
// array positions sometime around 2026-09-16, breaking the old approach.
//
// CORRECTED 2026-09-24 (second pass): the first fix matched id=rtHi/rtLo/
// rtVol/rtPrice2 ANYWHERE in the page — confirmed wrong via a live test
// that returned volume=274 instead of the real 5,503. 274 is real data
// from elsewhere on the page (matches data[7] in the old blob), meaning
// these IDs are NOT unique on the page and the bare match grabbed a
// different element than the visible summary box. Every field is now
// extracted only from within the specific <div id=quoteDiv>...
// <div id=partialContent1> region — the exact block confirmed (via a real
// page fetch) to contain the labeled "Previous / End of day / High / Low
// / Volume / Turnover / 52-week Range" summary a visitor actually sees.

const MYSTOCKS_BASE = 'https://live.mystocks.co.ke/stock='

export interface ScrapedQuote {
  ticker: string
  date: string
  close: number
  high: number
  low: number
  volume: number
  open: number
  marketStatus: string
  raw: string
}

function parseNumber(s: string | undefined): number {
  if (!s) return NaN
  return parseFloat(s.replace(/,/g, ''))
}

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

// Isolates the specific summary box (confirmed unique start/end markers
// via a real page fetch) so every field below is read from THIS region
// only, never from a same-named element elsewhere on the page (e.g. a
// "similar stocks" widget or a secondary panel).
function extractQuoteBoxHtml(html: string): string {
  const startIdx = html.indexOf('id=quoteDiv')
  const endIdx = html.indexOf('id=partialContent1', startIdx)
  if (startIdx === -1 || endIdx === -1) {
    throw new Error('myStocks: could not locate the quoteDiv summary box on the page (structure may have changed).')
  }
  return html.slice(startIdx, endIdx)
}

function extractMarketStatus(fullHtml: string): string {
  const blobMatch = fullHtml.match(/id=rtDataJson[^>]*>(\{.*?\})<\/div>/s)
  if (!blobMatch) return 'unknown'
  const decoded = decodeHtmlEntities(blobMatch[1])
  const marketMatch = decoded.match(/"market":"([^"]*)"/)
  return marketMatch ? marketMatch[1] : 'unknown'
}

function extractById(scopedHtml: string, id: string): string | undefined {
  const m = scopedHtml.match(new RegExp('id=["\']?' + id + '["\']?>([^<]*)<'))
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
  const box = extractQuoteBoxHtml(html)

  const closeStr = extractById(box, 'rtPrice2')
  const highStr = extractById(box, 'rtHi')
  const lowStr = extractById(box, 'rtLo')
  const volStr = extractById(box, 'rtVol')

  if (!closeStr || !highStr || !lowStr || !volStr) {
    const missing = [
      !closeStr && 'rtPrice2 (close)',
      !highStr && 'rtHi (high)',
      !lowStr && 'rtLo (low)',
      !volStr && 'rtVol (volume)',
    ].filter(Boolean).join(', ')
    throw new Error(
      'myStocks: could not find expected field(s) for ' + ticker + ' within the quoteDiv box: ' + missing + '. Box content: ' + box.slice(0, 500)
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
    open: close,
    marketStatus: extractMarketStatus(html),
    raw: 'close=' + closeStr + ' high=' + highStr + ' low=' + lowStr + ' vol=' + volStr,
  }
}
