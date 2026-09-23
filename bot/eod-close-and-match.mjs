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

const STOCK_BANDS = {
  "Stanbic Bank": 1.5,
  "Co-op Bank": 1.0,
  "Kenya Re": 1.0,
  "ABSA NewGold ETF": 2.0,
  "Crown Paints": 1.0,
};
const DEFAULT_BAND = 1.5;

function previousTradingDay(fromDateStr) {
  const d = new Date(fromDateStr);
  d.setDate(d.getDate() - 1);
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() - 1);
  }
  return d.toISOString().slice(0, 10);
}

function safeName(name) {
  return name.replace(/\s+/g, "_");
}

async function updateOfficialCloseInDataset(supabase, name, closePrice, today) {
  const key = `iq_stock_${safeName(name)}`;
  const { data: existing } = await supabase.from("kv").select("value").eq("key", key).maybeSingle();
  const rows = Array.isArray(existing?.value) ? existing.value : [];

  const newRow = { date: today, open: closePrice, high: closePrice, low: closePrice, close: closePrice, volume: null };
  const idx = rows.findIndex((r) => r.date === today);
  if (idx >= 0) rows[idx] = newRow;
  else rows.push(newRow);
  rows.sort((a, b) => String(a.date).localeCompare(String(b.date)));

  const { error } = await supabase.from("kv").upsert({ key, value: rows, updated_at: new Date().toISOString() });
  if (error) throw error;
  return rows.length;
}

async function archiveClose(supabase, name, ticker, closePrice, today) {
  await supabase.from("daily_price_archive").insert({
    stock_name: name,
    ticker,
    trade_date: today,
    open: closePrice,
    high: closePrice,
    low: closePrice,
    close: closePrice,
    volume: null,
    market_status: "closed",
    raw_blob: { source: "soko_play_bot", note: "close-only fallback, myStocks blocked" },
  });
}

async function reconcileIntradayMatch(supabase, ticker, today) {
  const predictionDate = previousTradingDay(today);
  const { data: prediction } = await supabase
    .from("predictions")
    .select("action, price, stock_name")
    .eq("ticker", ticker)
    .eq("date", predictionDate)
    .maybeSingle();

  if (!prediction || prediction.action === "HOLD") {
    return { ticker, status: prediction ? "skipped_hold" : "no_prediction", predictionDate };
  }

  const { data: checkpoints } = await supabase
    .from("intraday_prices")
    .select("price, checked_at")
    .eq("ticker", ticker)
    .eq("trade_date", today)
    .order("checked_at", { ascending: true });

  if (!checkpoints || checkpoints.length === 0) {
    return { ticker, status: "no_checkpoints" };
  }

  const band = STOCK_BANDS[prediction.stock_name] || DEFAULT_BAND;
  const signalPrice = prediction.price;

  let best = null;
  for (const cp of checkpoints) {
    const pctChange = ((cp.price - signalPrice) / signalPrice) * 100;
    const supportsDirection = prediction.action === "BUY" ? pctChange : -pctChange;
    if (!best || supportsDirection > best.supportsDirection) {
      best = { ...cp, pctChange, supportsDirection };
    }
  }

  const matched = best.supportsDirection > band;

  await supabase.from("prediction_intraday_match").upsert(
    {
      ticker,
      trade_date: today,
      predicted_action: prediction.action,
      matched_price: best.price,
      matched_at: best.checked_at,
      matched,
    },
    { onConflict: "ticker,trade_date" }
  );

  return { ticker, status: "reconciled", matched, matchedAt: best.checked_at, matchedPrice: best.price };
}

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
        const { price } = await readStockPrice(page, searchTermFor(name));
        const rowCount = await updateOfficialCloseInDataset(supabase, name, price, today);
        await archiveClose(supabase, name, ticker, price, today);
        console.log(`[eod] ${ticker}: close=${price}, dataset now has ${rowCount} rows`);
        await logRun(supabase, { runType: "eod", ticker, status: "success", price, message: `Dataset now has ${rowCount} rows` });

        const reconciliation = await reconcileIntradayMatch(supabase, ticker, today);
        console.log(`[eod] ${ticker} intraday reconciliation:`, JSON.stringify(reconciliation));
      } catch (err) {
        console.error(`[eod] Failed for ${name} (${ticker}):`, err.message);
        await logRun(supabase, { runType: "eod", ticker, status: "failed", message: err.message });
      } finally {
        await page.close();
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  } finally {
    await browser.close();
  }

  const { VERCEL_APP_URL, CRON_SECRET } = process.env;
  if (VERCEL_APP_URL && CRON_SECRET) {
    try {
      console.log(`[eod] Triggering ${VERCEL_APP_URL}/api/nse/fetch ...`);
      const res = await fetch(`${VERCEL_APP_URL}/api/nse/fetch`, {
        headers: { Authorization: `Bearer ${CRON_SECRET}` },
      });
      const body = await res.json();
      console.log(`[eod] Pipeline trigger response (HTTP ${res.status}):`, JSON.stringify(body));
    } catch (err) {
      console.error("[eod] Failed to trigger the Vercel pipeline:", err.message);
    }
  } else {
    console.warn(
      "[eod] VERCEL_APP_URL or CRON_SECRET not set in .env — skipping pipeline trigger. " +
        "Add both to actually close the loop (see bot/README.md)."
    );
  }
}

main().catch((err) => {
  console.error("[eod] Fatal error:", err);
  process.exitCode = 1;
});
