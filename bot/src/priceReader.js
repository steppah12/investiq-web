import { openStockPickerModal, findStockRow } from "./trade.js";

/**
 * Navigates to a stock's detail page and reads its current price.
 *
 * NOT YET LIVE-VERIFIED (like submitOrderForm was before testing) — the
 * modal/search/row-finding part IS confirmed working (same code path as
 * placeTrade, tested extensively). What's unverified is the exact
 * selector for reading LTP on the detail page — built from a screenshot
 * of that page, not a live HTML dump like the fixes that came before it.
 * Test this against one stock before trusting the hourly cron with it.
 *
 * @param {import('playwright').Page} page
 * @param {string} tickerOrName
 * @returns {Promise<{ price: number, prevClose: number|null, timestamp: string }>}
 */
export async function readStockPrice(page, tickerOrName) {
  await page.goto("https://academy.nse.co.ke/trader/dashboard", { waitUntil: "domcontentloaded" });

  const modal = await openStockPickerModal(page);
  const row = await findStockRow(modal, tickerOrName);

  // The row is confirmed clickable (PrimeReact "selectable row" styling
  // seen in the real HTML dump) — click the row itself rather than
  // guessing at a specific link inside it, which navigates to the detail
  // page (confirmed behavior from placeTrade's Buy-button click landing
  // on /trader/stock/<id>).
  await row.click();
  await page.waitForURL(/\/trader\/stock\/\d+/, { timeout: 10000 });

  // LTP (Last Traded Price) confirmed visible on the detail page via
  // screenshot, alongside PREV CLOSE. Both rendered as a label above the
  // value — same "label text, then nearby number" pattern used
  // successfully for Cash Balance.
  // Same class of bug as Cash Balance and the order form: the price panel
  // likely shows a placeholder (here: "0.00") briefly after navigating,
  // before the real numbers load via a follow-up API call. Poll for a
  // stable, non-zero value instead of reading once immediately.
  async function readNumberNear(label) {
    const container = label.locator("xpath=ancestor::*[position()<=3]").last();
    const deadline = Date.now() + 8000;
    let lastValue = null;
    while (Date.now() < deadline) {
      const text = await container.innerText().catch(() => "");
      const match = text.match(/[\d,]+(?:\.\d+)?/);
      const value = match ? parseFloat(match[0].replace(/,/g, "")) : null;
      if (value != null && value > 0) return value;
      lastValue = value;
      await page.waitForTimeout(500);
    }
    return lastValue; // may be 0/null — caller decides how to handle that
  }

  const ltpLabel = page.getByText(/^LTP$/i).first();
  await ltpLabel.waitFor({ state: "attached", timeout: 10000 });
  const price = await readNumberNear(ltpLabel);

  let prevClose = null;
  const prevCloseLabel = page.getByText(/prev\s*close/i).first();
  if ((await prevCloseLabel.count()) > 0) {
    prevClose = await readNumberNear(prevCloseLabel);
  }

  if (!(price > 0)) {
    throw new Error(
      `readStockPrice: LTP read as ${price} for "${tickerOrName}" — likely no trade has happened yet today ` +
        `(this is expected right after market open, but should never be silently accepted as a real close). ` +
        `prevClose was ${prevClose ?? "unavailable"}.`
    );
  }

  return { price, prevClose, timestamp: new Date().toISOString() };
}
