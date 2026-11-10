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

function safeName(name) {
  return name.replace(/\s+/g, "_");
}

function previousTradingDay() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() - 1);
  }
  return d.toISOString().slice(0, 10);
}

async function main() {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env");
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const yesterday = previousTradingDay();
  console.log(`[reconcile] Checking ${yesterday}'s close against the platform's CLOSE PRICE (last completed session) for each stock.`);

  const { browser, context } = await launchSession({ headless: true });
  try {
    for (const [name, ticker] of Object.entries(TRACKED_STOCKS)) {
      const page = await context.newPage();
      try {
        const { closePrice: platformClose } = await readStockPrice(page, searchTermFor(name), { allowNoTrade: true });
        if (platformClose == null) {
          console.warn(`[reconcile] ${ticker}: no CLOSE PRICE available, skipping.`);
          await logRun(supabase, { runType: "reconcile", ticker, status: "failed", message: "No CLOSE PRICE available" });
          continue;
        }

        const key = `iq_stock_${safeName(name)}`;
        const { data: existing } = await supabase.from("kv").select("value").eq("key", key).maybeSingle();
        const rows = Array.isArray(existing?.value) ? existing.value : [];
        const idx = rows.findIndex((r) => r.date === yesterday);

        if (idx === -1) {
          console.warn(`[reconcile] ${ticker}: no row for ${yesterday} yet — EOD script may not have run.`);
          await logRun(supabase, { runType: "reconcile", ticker, status: "failed", message: `No row for ${yesterday}` });
          continue;
        }

        const capturedClose = rows[idx].close;
        const diff = Math.abs(capturedClose - platformClose);

        if (diff < 0.001) {
          console.log(`[reconcile] ${ticker}: matches (${capturedClose}), no correction needed.`);
          await logRun(supabase, { runType: "reconcile", ticker, status: "success", price: capturedClose, message: "Matched, no correction needed" });
          continue;
        }

        // CHANGED 2026-09-27: this used to overwrite iq_stock_<name> (the shared training dataset) whenever Soko Play's PREV CLOSE disagreed with what was captured. myStocks is now trusted directly; this just LOGS the mismatch without touching the dataset.
        console.warn(
          `[reconcile] ${ticker}: mismatch noted (captured ${capturedClose} vs Soko Play CLOSE PRICE ${platformClose}) — NOT correcting the training dataset (myStocks owns that now).`
        );
        await logRun(supabase, { runType: "reconcile", ticker, status: "success", price: platformClose, message: `Mismatch noted only (captured ${capturedClose} vs ${platformClose}) — dataset not touched, myStocks is the source of truth` });
      } catch (err) {
        console.error(`[reconcile] Failed for ${name} (${ticker}):`, err.message);
        await logRun(supabase, { runType: "reconcile", ticker, status: "failed", message: err.message });
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
  console.error("[reconcile] Fatal error:", err);
  // Exit now: an open browser would otherwise keep the process alive until the cron timeout.
  process.exit(1);
});
