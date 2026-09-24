// src/regretEngine.js
//
// This is the "learn and correct itself by force" piece.
//
// Every day your prediction pipeline should log TWO things per stock,
// not just the final trade:
//   - raw_action / raw_confidence: what the ungated ensemble wanted
//     (e.g. a strong BUY on KCB)
//   - gated_action: what your risk rules actually allowed
//     (e.g. HOLD, because confidence sat just under threshold)
//
// The next trading day, once we know the new closing price, this script:
//   1. Computes the "shadow" return — what raw_action would have earned.
//   2. Computes the "actual" return — what gated_action earned.
//   3. regret = shadow_return - actual_return
//        positive regret => the gate blocked a decision that would have paid off
//        negative regret => the gate correctly blocked a bad call
//   4. Feeds regret into a per-ticker trust_score (EMA), which your
//      inference pipeline should read back to loosen/tighten that
//      stock's confidence threshold over time.
//
// See schema.sql for the two tables this expects: daily_signals, stock_trust.
//
// Run daily, shortly after the new closing prices land (i.e. right
// after your existing 4pm fetch cron), via `npm run regret`.

import { createClient } from "@supabase/supabase-js";
import "dotenv/config";

const EMA_ALPHA = 0.2; // how fast trust reacts to new regret; raise to react faster
const TRUST_TO_THRESHOLD_SCALE = 0.15; // max threshold shift a maxed-out trust score can cause
const TRUST_CLAMP = 3; // trust_score is kept within [-TRUST_CLAMP, TRUST_CLAMP]

function assertEnv() {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env");
  }
  return { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY };
}

function directionalReturn(action, priceThen, priceNow) {
  const rawReturn = (priceNow - priceThen) / priceThen;
  if (action === "BUY") return rawReturn;
  if (action === "SELL") return -rawReturn; // shorting/avoiding downside
  return 0; // HOLD earns nothing, risks nothing
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Pulls all signals that are due for scoring: they have no computed
 * regret yet, and a next-trading-day price now exists for that ticker.
 */
async function fetchUnscoredSignals(supabase) {
  const { data, error } = await supabase
    .from("daily_signals")
    .select("*")
    .is("regret", null)
    .order("signal_date", { ascending: true });

  if (error) throw error;
  return data ?? [];
}

async function fetchNextClose(supabase, ticker, afterDate) {
  // daily_price_archive already exists (populated by the main app's scraper)
  // and has exactly this shape — no separate "prices" table needed.
  const { data, error } = await supabase
    .from("daily_price_archive")
    .select("trade_date, close")
    .eq("ticker", ticker)
    .gt("trade_date", afterDate)
    .order("trade_date", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;
  return { date: data.trade_date, close: data.close }; // normalize to what callers expect
}

async function getTrust(supabase, ticker) {
  const { data, error } = await supabase
    .from("stock_trust")
    .select("*")
    .eq("ticker", ticker)
    .maybeSingle();

  if (error) throw error;
  return data?.trust_score ?? 0;
}

async function upsertTrust(supabase, ticker, newTrust) {
  const { error } = await supabase
    .from("stock_trust")
    .upsert(
      { ticker, trust_score: newTrust, updated_at: new Date().toISOString() },
      { onConflict: "ticker" }
    );
  if (error) throw error;
}

async function markScored(supabase, signalId, fields) {
  const { error } = await supabase.from("daily_signals").update(fields).eq("id", signalId);
  if (error) throw error;
}

/**
 * Converts a trust score into the threshold adjustment your inference
 * pipeline should apply for that ticker. Positive trust (raw signal has
 * been paying off) LOWERS the bar to act; negative trust RAISES it.
 * Call this from your ML pipeline when finalizing gated decisions.
 */
export function trustToThresholdAdjustment(trustScore) {
  const normalized = clamp(trustScore, -TRUST_CLAMP, TRUST_CLAMP) / TRUST_CLAMP;
  return -normalized * TRUST_TO_THRESHOLD_SCALE; // negative = easier to trigger BUY
}

export async function runRegretPass() {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = assertEnv();
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const pending = await fetchUnscoredSignals(supabase);
  console.log(`[regret] ${pending.length} signal(s) awaiting scoring.`);

  for (const signal of pending) {
    const { id, ticker, signal_date, raw_action, gated_action, price_at_signal } = signal;

    const next = await fetchNextClose(supabase, ticker, signal_date);
    if (!next) {
      console.log(`[regret] ${ticker} (${signal_date}) — next price not in yet, skipping.`);
      continue;
    }

    const shadowReturn = directionalReturn(raw_action, price_at_signal, next.close);
    const actualReturn = directionalReturn(gated_action, price_at_signal, next.close);
    const regret = shadowReturn - actualReturn;

    const currentTrust = await getTrust(supabase, ticker);
    // Regret sign feeds trust: consistently-blocked-but-correct raw
    // signals push trust up (loosen the gate); the opposite pulls it down.
    const regretSignal = clamp(regret * 10, -1, 1); // scale a ~10% miss to a full-strength update
    const newTrust = EMA_ALPHA * regretSignal + (1 - EMA_ALPHA) * currentTrust;

    await upsertTrust(supabase, ticker, newTrust);
    await markScored(supabase, id, {
      next_close: next.close,
      shadow_return: shadowReturn,
      actual_return: actualReturn,
      regret,
    });

    console.log(
      `[regret] ${ticker}: raw=${raw_action} gated=${gated_action} ` +
        `regret=${(regret * 100).toFixed(2)}% trust=${newTrust.toFixed(3)} ` +
        `(threshold adj: ${trustToThresholdAdjustment(newTrust).toFixed(3)})`
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runRegretPass();
}
