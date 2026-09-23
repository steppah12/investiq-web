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
  console.log(`[reconcile] Checking ${yesterday}'s close against today's PREV CLOSE for each stock.`);

  const { browser, context } = await launchSession({ headless: true });
  try {
    for (const [name, ticker] of Object.entries(TRACKED_STOCKS)) {
      const page = await context.newPage();
      try {
        const { prevClose } = await readStockPrice(page, searchTermFor(name));
        if (prevClose == null) {
          console.warn(`[reconcile] ${ticker}: no PREV CLOSE available, skipping.`);
          await logRun(supabase, { runType: "reconcile", ticker, status: "failed", message: "No PREV CLOSE available" });
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
        const diff = Math.abs(capturedClose - prevClose);

        if (diff < 0.001) {
          console.log(`[reconcile] ${ticker}: matches (${capturedClose}), no correction needed.`);
          await logRun(supabase, { runType: "reconcile", ticker, status: "success", price: capturedClose, message: "Matched, no correction needed" });
          continue;
        }

        console.warn(
          `[reconcile] ${ticker}: MISMATCH — captured ${capturedClose}, official PREV CLOSE is ${prevClose}. Correcting.`
        );
        rows[idx] = { ...rows[idx], open: prevClose, high: prevClose, low: prevClose, close: prevClose };
        const { error } = await supabase.from("kv").upsert({ key, value: rows, updated_at: new Date().toISOString() });
        if (error) throw error;

        await supabase.from("daily_price_archive").insert({
          stock_name: name,
          ticker,
          trade_date: yesterday,
          open: prevClose,
          high: prevClose,
          low: prevClose,
          close: prevClose,
          volume: null,
          market_status: "closed",
          raw_blob: { source: "soko_play_bot_reconciliation", correctedFrom: capturedClose },
        });

        await logRun(supabase, { runType: "reconcile", ticker, status: "success", price: prevClose, message: `Corrected from ${capturedClose} to ${prevClose}` });
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
  process.exitCode = 1;
});
