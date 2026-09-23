import { createClient } from "@supabase/supabase-js";
import "dotenv/config";
import { launchSession } from "./src/session.js";
import { readStockPrice } from "./src/priceReader.js";
import { searchTermFor } from "./src/stockNameMap.js";
import { logRun } from "./src/runLog.js";

const TRACKED_STOCKS = {
  "Stanbic Bank": "SBIC",
  "Co-op Bank": "COOP",
  "Kenya Re": "KNRE",
  "ABSA NewGold ETF": "GLD",
  "Crown Paints": "CRWN",
};

async function main() {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env");
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const today = new Date().toISOString().slice(0, 10);

  const { browser, context } = await launchSession({ headless: true });
  try {
    for (const [name, ticker] of Object.entries(TRACKED_STOCKS)) {
      const page = await context.newPage();
      try {
        const { price, timestamp } = await readStockPrice(page, searchTermFor(name));
        const { error } = await supabase.from("intraday_prices").insert({
          ticker,
          trade_date: today,
          price,
          checked_at: timestamp,
        });
        if (error) throw error;
        console.log(`[hourly] ${ticker}: ${price} @ ${timestamp}`);
        await logRun(supabase, { runType: "hourly", ticker, status: "success", price, message: `Logged at ${timestamp}` });
      } catch (err) {
        console.error(`[hourly] Failed for ${name} (${ticker}):`, err.message);
        await logRun(supabase, { runType: "hourly", ticker, status: "failed", message: err.message });
      } finally {
        await page.close();
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("[hourly] Fatal error:", err);
  process.exitCode = 1;
});
