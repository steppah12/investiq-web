// Fetches each tracked stock's myStocks quote page from THIS machine and posts the HTML to the app, which
// parses and stores it with all its usual checks. Added 2026-11-17: myStocks started answering HTTP 403 to
// Vercel's servers on 2026-11-16, while this machine's requests (same headers) still get HTTP 200.

const TICKERS = ["SBIC", "COOP", "KNRE", "GLD", "CRWN"];
const MYSTOCKS_BASE = "https://live.mystocks.co.ke/stock=";

// Same headers the app sends (src/lib/scraper/mystocks.ts).
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://live.mystocks.co.ke/",
  "Upgrade-Insecure-Requests": "1",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "same-origin",
};

/**
 * Returns how many pages the app accepted (HTTP 2xx). Never throws: a failure for one stock is logged and skipped.
 * `options.sourceBase` and `options.tickers` exist for tests.
 */
export async function ingestMyStocksPages(appUrl, secret, options = {}) {
  const tickers = options.tickers || TICKERS;
  const sourceBase = options.sourceBase || MYSTOCKS_BASE;
  const pauseMs = options.pauseMs ?? 1500;
  let accepted = 0;
  for (const ticker of tickers) {
    try {
      const res = await fetch(sourceBase + encodeURIComponent(ticker), {
        headers: HEADERS,
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) {
        console.warn(`[ingest] ${ticker}: myStocks answered HTTP ${res.status} to this machine, skipping.`);
        continue;
      }
      const html = await res.text();
      const post = await fetch(`${appUrl}/api/nse/fetch`, {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ticker, html }),
        signal: AbortSignal.timeout(60000),
      });
      const body = await post.json().catch(() => ({}));
      const outcome = body?.result?.status ?? body?.error ?? "no status";
      console.log(`[ingest] ${ticker}: app answered HTTP ${post.status} (${outcome})`);
      if (post.ok) accepted += 1;
    } catch (err) {
      console.warn(`[ingest] ${ticker}: failed (${err.message}), skipping.`);
    }
    if (pauseMs > 0) await new Promise((r) => setTimeout(r, pauseMs));
  }
  console.log(`[ingest] ${accepted} of ${tickers.length} page(s) accepted by the app.`);
  return accepted;
}
