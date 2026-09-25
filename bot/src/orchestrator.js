// src/orchestrator.js
//
// The daily entry point. Run this on a schedule shortly AFTER your
// existing price-fetch + prediction cron. It expects predictions to
// already exist in Supabase — this script does NOT run the ML pipeline
// itself; all modeling happens in the main investiq-web app.
//
// For each stock with a fresh prediction today, it:
//   1. Records the raw vs. gated decision into daily_signals (for the
//      regret engine to score tomorrow).
//   2. If the gated decision is BUY or SELL, sizes the trade using the
//      model's own Kelly% against real available cash, logs into Soko
//      Play (auto-refreshing the session if needed), and places it.
//
// CORRECTED 2026-09-23 after live-testing BUY and SELL on Stanbic:
//   - Each trade attempt is now wrapped in try/catch, so one failure
//     (e.g. a selector break) no longer kills every trade after it in
//     the same run.
//   - Every trade attempt is verified via a real before/after
//     getAccountSnapshot() cash-balance delta, not just "Submit was
//     clicked" — and logged to bot_run_log either way.
//   - SELL position matching now uses holdings' real shape
//     ({name, shares} — full company name, e.g. "Stanbic Holdings Plc")
//     instead of a {ticker} field that portfolio.js never actually
//     returns. Matches by substring against searchTermFor(stock_name).
//
// TRADE SIZING: this is virtual money on NSE's own education platform, so
// there's no cap on trade *count* here — every signal that clears the gate
// gets acted on. Position *size* still can't exceed what the account
// actually has — see sizeTrade() below, which uses FULL Kelly (not the
// more conservative half-Kelly common for real capital) since the whole
// point of this phase is to see the strategy under real pressure without
// real consequences.

import { createClient } from "@supabase/supabase-js";
import "dotenv/config";
import { launchSession, withSession } from "./session.js";
import { placeTrade } from "./trade.js";
import { getAccountSnapshot, verifyTradeFilled, isMarketOpen } from "./portfolio.js";
import { trustToThresholdAdjustment } from "./regretEngine.js";
import { searchTermFor } from "./stockNameMap.js";
import { logRun } from "./runLog.js";

const MAX_TRADES_PER_DAY = process.env.MAX_TRADES_PER_DAY
  ? Number(process.env.MAX_TRADES_PER_DAY)
  : Infinity;
const BASE_CONFIDENCE_THRESHOLD = Number(process.env.BASE_CONFIDENCE_THRESHOLD ?? 0.6);
const LEARNING_MODE = process.env.LEARNING_MODE === "true";
const MIN_TRADE_VALUE = Number(process.env.MIN_TRADE_VALUE ?? 1);

function assertEnv() {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env");
  }
  return { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY };
}

async function fetchTodaysRawSignals(supabase, today) {
  const { data, error } = await supabase
    .from("predictions")
    .select("ticker, stock_name, date, price, action, confidence, kelly_pct")
    .eq("date", today);

  if (error) throw error;
  return data ?? [];
}

async function filterByActiveRoster(supabase, signals) {
  const { data, error } = await supabase
    .from("kv")
    .select("value")
    .eq("key", "iq_lab_roster")
    .maybeSingle();

  if (error) {
    console.warn("[orchestrator] Could not read roster (non-fatal, trading all signals):", error.message);
    return signals;
  }
  const roster = data?.value;
  if (!roster || Object.keys(roster).length === 0) {
    return signals;
  }

  const activeSignals = signals.filter((s) => roster[s.stock_name]?.tier === "active");
  const skipped = signals.length - activeSignals.length;
  if (skipped > 0) {
    console.log("[orchestrator] Roster active — skipping " + skipped + " benched-tier signal(s).");
  }
  return activeSignals;
}

async function gateDecision(supabase, signal) {
  if (LEARNING_MODE) {
    return { gatedAction: signal.action, effectiveThreshold: null, trustScore: null };
  }

  const { data: trustRow } = await supabase
    .from("stock_trust")
    .select("trust_score")
    .eq("ticker", signal.ticker)
    .maybeSingle();

  const trustScore = trustRow?.trust_score ?? 0;
  const adjustment = trustToThresholdAdjustment(trustScore);
  const effectiveThreshold = BASE_CONFIDENCE_THRESHOLD + adjustment;

  const clearsBar = signal.confidence >= effectiveThreshold;
  const gatedAction = clearsBar ? signal.action : "HOLD";

  return { gatedAction, effectiveThreshold, trustScore };
}

async function logSignal(supabase, signal, gatedAction, gatedConfidence) {
  const { error } = await supabase.from("daily_signals").upsert(
    {
      ticker: signal.ticker,
      signal_date: signal.date,
      price_at_signal: signal.price,
      raw_action: signal.action,
      raw_confidence: signal.confidence,
      gated_action: gatedAction,
      gated_confidence: gatedConfidence,
    },
    { onConflict: "ticker,signal_date" }
  );
  if (error) throw error;
}

function sizeTrade(signal, availableCash) {
  const kellyFraction = Math.max(0, Math.min(1, (signal.kelly_pct ?? 0) / 100));
  const allocation = availableCash * kellyFraction;
  const shares = Math.floor(allocation / signal.price);
  const cost = shares * signal.price;
  return { shares, cost };
}

function findHoldingForStock(holdings, stockName) {
  const searchName = searchTermFor(stockName).toLowerCase();
  return holdings.find(
    (h) => h.name.toLowerCase().includes(searchName) || searchName.includes(h.name.toLowerCase())
  );
}

async function alreadyTradedToday(supabase, ticker, today) {
  const result = await supabase
    .from("bot_run_log")
    .select("id")
    .eq("run_type", "trade")
    .eq("ticker", ticker)
    .eq("status", "success")
    .gte("ran_at", today + "T00:00:00")
    .limit(1);
  if (result.error) {
    console.warn("[orchestrator] Could not check prior trades - failing safe:", result.error.message);
    return true;
  }
  return (result.data || []).length > 0;
}

async function run() {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = assertEnv();
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const today = new Date().toISOString().slice(0, 10);
  const rawSignals = await fetchTodaysRawSignals(supabase, today);
  const signals = await filterByActiveRoster(supabase, rawSignals);
  console.log(
    "[orchestrator] " + rawSignals.length + " raw signal(s) for " + today +
      (signals.length !== rawSignals.length ? ", " + signals.length + " after roster filter." : ".")
  );

  const tradesToExecute = [];

  for (const signal of signals) {
    const { gatedAction, effectiveThreshold, trustScore } = await gateDecision(supabase, signal);
    await logSignal(supabase, signal, gatedAction, effectiveThreshold);

    const trustLabel = LEARNING_MODE ? "n/a (learning mode)" : trustScore.toFixed(2);
    const thresholdLabel = LEARNING_MODE ? "n/a (learning mode)" : effectiveThreshold.toFixed(2);
    console.log(
      "[orchestrator] " + signal.ticker + ": raw=" + signal.action + "(" + signal.confidence.toFixed(2) + ") " +
        "kelly=" + (signal.kelly_pct ?? "n/a") + "% trust=" + trustLabel + " threshold=" + thresholdLabel + " => gated=" + gatedAction
    );

    if (gatedAction === "BUY" || gatedAction === "SELL") {
      tradesToExecute.push({ ...signal, action: gatedAction });
    }
  }

  if (tradesToExecute.length === 0) {
    console.log("[orchestrator] No trades to execute today.");
    return;
  }

  const capped = Number.isFinite(MAX_TRADES_PER_DAY)
    ? tradesToExecute.slice(0, MAX_TRADES_PER_DAY)
    : tradesToExecute;
  if (capped.length < tradesToExecute.length) {
    console.warn(
      "[orchestrator] " + tradesToExecute.length + " trades gated through, " +
        "capping to MAX_TRADES_PER_DAY=" + MAX_TRADES_PER_DAY + "."
    );
  }

  const { browser, page } = await launchSession({ headless: true });
  try {
    // Added 2026-09-25 after confirming via a live test that Orders/create
    // returns {"Message":"Order Placed Successfully"} even during
    // "Closing Price Publication" (post-close), while the order never
    // actually appears in matchedorders, pendingorders, or holdings — it
    // is silently discarded, not queued. Checking real market status
    // FIRST is the only reliable guard; the create-call's response text
    // cannot be trusted to mean a trade will actually happen.
    const marketOpen = await isMarketOpen(page);
    if (!marketOpen) {
      console.warn("[orchestrator] Market is not open (Closing Price Publication or similar) — refusing to place any trades this run.");
      for (const signal of capped) {
        await logRun(supabase, {
          runType: "trade", ticker: signal.ticker, status: "failed",
          message: "Market not open — trade not attempted (Orders/create silently discards orders placed post-close)",
        });
      }
      return;
    }

    const { cashBalance } = await getAccountSnapshot(page);
    console.log("[orchestrator] Starting cash balance: " + cashBalance);

    let availableCash = cashBalance;

    for (const signal of capped) {
      try {
        const already = await alreadyTradedToday(supabase, signal.ticker, today);
        if (already) {
          console.log("[orchestrator] Skipping " + signal.ticker + " " + signal.action + " - already traded today.");
          continue;
        }
        if (signal.action === "BUY") {
          const { shares, cost } = sizeTrade(signal, availableCash);
          if (cost < MIN_TRADE_VALUE || shares === 0) {
            console.log(
              "[orchestrator] Skipping " + signal.ticker + " BUY — computed size too small (" +
                shares + " shares, " + cost + " cost against " + availableCash + " available)."
            );
            continue;
          }
          console.log(
            "[orchestrator] " + signal.ticker + " BUY: " + shares + " shares @ ~" + signal.price +
              " (kelly=" + signal.kelly_pct + "%, cost=" + cost + ", remaining after=" + (availableCash - cost) + ")"
          );

          const placeResult = await withSession(page, (p) => placeTrade(p, searchTermFor(signal.stock_name), "BUY", { quantity: shares }));
          const verified = placeResult && placeResult.symbolId
            ? await verifyTradeFilled(page, { symbolId: placeResult.symbolId, side: "BUY", quantity: shares, submittedAfter: placeResult.submittedAfter })
            : { filled: false };

          if (verified.filled) {
            console.log("[orchestrator] " + signal.ticker + " BUY CONFIRMED via matched order " + verified.order.ShortOrderId);
            await logRun(supabase, {
              runType: "trade", ticker: signal.ticker, status: "success", price: signal.price,
              message: "BUY " + shares + " shares, confirmed via order " + verified.order.ShortOrderId,
            });
            availableCash -= cost;
          } else {
            console.warn("[orchestrator] " + signal.ticker + " BUY submitted but NOT confirmed in matched orders after 60s — will retry next run.");
            await logRun(supabase, {
              runType: "trade", ticker: signal.ticker, status: "unconfirmed", price: signal.price,
              message: "BUY " + shares + " shares submitted, no matching order found within 60s",
            });
          }
        } else {
          const snapshot = await getAccountSnapshot(page);
          const position = findHoldingForStock(snapshot.holdings, signal.stock_name);

          if (!position || position.shares === 0) {
            console.log("[orchestrator] Skipping " + signal.ticker + " SELL — no position held.");
            await logRun(supabase, {
              runType: "trade",
              ticker: signal.ticker,
              status: "failed",
              message: "No position held",
            });
            continue;
          }

          console.log("[orchestrator] " + signal.ticker + " SELL: " + position.shares + " shares (full position).");

          const placeResult = await withSession(page, (p) => placeTrade(p, searchTermFor(signal.stock_name), "SELL", { quantity: position.shares }));
          const verified = placeResult && placeResult.symbolId
            ? await verifyTradeFilled(page, { symbolId: placeResult.symbolId, side: "SELL", quantity: position.shares, submittedAfter: placeResult.submittedAfter })
            : { filled: false };

          if (verified.filled) {
            console.log("[orchestrator] " + signal.ticker + " SELL CONFIRMED via matched order " + verified.order.ShortOrderId);
            await logRun(supabase, {
              runType: "trade", ticker: signal.ticker, status: "success", price: signal.price,
              message: "SELL " + position.shares + " shares, confirmed via order " + verified.order.ShortOrderId,
            });
          } else {
            console.warn("[orchestrator] " + signal.ticker + " SELL submitted but NOT confirmed in matched orders after 60s — will retry next run.");
            await logRun(supabase, {
              runType: "trade", ticker: signal.ticker, status: "unconfirmed", price: signal.price,
              message: "SELL " + position.shares + " shares submitted, no matching order found within 60s",
            });
          }
        }
      } catch (err) {
        console.error("[orchestrator] Failed to execute " + signal.action + " for " + signal.ticker + ":", err.message);
        await logRun(supabase, {
          runType: "trade",
          ticker: signal.ticker,
          status: "failed",
          message: err.message,
        });
      }
    }
  } finally {
    await browser.close();
  }
}

run().catch((err) => {
  console.error("[orchestrator] Fatal error:", err);
  process.exitCode = 1;
});
