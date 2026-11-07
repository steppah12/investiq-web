// grade-signals.mjs
// Grades every row in daily_signals once the next trading day's OFFICIAL data exists:
//   - was the model's direction right (raw_action vs the next close)? Days the stock closed
//     unchanged are counted separately, because they are neither right nor wrong.
//   - how did the signal do over 1, 3 and 5 trading days, before and after Soko Play's
//     commission (default 2% each way, so a round trip must clear 4%)?
//   - if the bot traded it: how far from the signal price was the real fill, and where in
//     that day's range (0 = the low, 1 = the high) did the fill land?
// It reads official OHLC from the iq_stock_* datasets (myStocks), NOT from daily_price_archive,
// and it maps BERG to Crown Paints (the old regret engine never could, because the archive
// calls it CRWN).
//
// Measuring only: it never changes trading behaviour. DRY RUN by default; --apply writes the
// grades into daily_signals (run the ledger-grading migration first).
//
// Usage (from ~/investiq-web/bot):
//   node grade-signals.mjs                    # dry run: prints grades and a summary
//   node grade-signals.mjs --apply            # write grades
//   node grade-signals.mjs --since=2026-09-23 # earliest signal_date to consider
//   node grade-signals.mjs --regrade          # include rows that were already graded
import { pathToFileURL } from "node:url";

export const DATASET_FOR = {
  SBIC: "Stanbic Bank",
  COOP: "Co-op Bank",
  KNRE: "Kenya Re",
  GLD: "ABSA NewGold ETF",
  BERG: "Crown Paints",
  CRWN: "Crown Paints",
};

const MAX_GAP_DAYS = 5; // weekend plus one holiday; a longer jump means a data hole, so do not grade across it
const DAY = 86400000;
const keyOf = (name) => "iq_stock_" + name.replace(/\s+/g, "_");
const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
const isFlat = (r) => r.volume === null || r.volume === undefined;
const dayDiff = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / DAY);

export function directionalReturn(action, from, to) {
  const r = (to - from) / from;
  if (action === "BUY") return r;
  if (action === "SELL") return -r;
  return 0;
}

// Nairobi calendar date of a timestamp (EAT = UTC+3, no daylight saving).
export function eatDate(ts) {
  const t = Date.parse(ts);
  return Number.isFinite(t) ? new Date(t + 3 * 3600000).toISOString().slice(0, 10) : null;
}

/**
 * Grade one signal against its dataset rows (sorted ascending by date).
 * Returns { skip: reason } or { fields: {...} } ready for daily_signals.
 */
export function gradeSignal(signal, rows, { fee = 0.02 } = {}) {
  const S = String(signal.signal_date).slice(0, 10);
  const p0 = num(signal.price_at_signal);
  if (!Number.isFinite(p0) || p0 <= 0) return { skip: "no signal price" };

  const next = rows.find((r) => r.date > S);
  if (!next) return { skip: "next day's official row not in yet" };
  if (dayDiff(S, next.date) > MAX_GAP_DAYS) return { skip: "data hole after the signal (next row " + next.date + ")" };

  const nextClose = num(next.close);
  const raw = signal.raw_action;
  const idx = rows.indexOf(next);
  // Directional return from the signal price to the close n trading rows later; null across a data hole.
  const forward = (n) => {
    if (raw !== "BUY" && raw !== "SELL") return null;
    let prev = S;
    for (let k = 0; k < n; k++) {
      const r = rows[idx + k];
      if (!r || dayDiff(prev, r.date) > MAX_GAP_DAYS) return null;
      prev = r.date;
    }
    return directionalReturn(raw, p0, num(rows[idx + n - 1].close));
  };
  const gated = signal.gated_action;
  const grossRaw = directionalReturn(raw, p0, nextClose);
  const shadow = grossRaw;
  const actual = directionalReturn(gated, p0, nextClose);

  const fields = {
    next_date: next.date,
    next_open: num(next.open),
    next_high: num(next.high),
    next_low: num(next.low),
    next_is_flat: isFlat(next),
    next_close: nextClose,
    ret_close_to_close: (nextClose - p0) / p0,
    shadow_return: shadow,
    actual_return: actual,
    regret: shadow - actual,
    direction_hit: raw === "BUY" ? nextClose > p0 : raw === "SELL" ? nextClose < p0 : null,
    net_ret_roundtrip: raw === "BUY" || raw === "SELL" ? grossRaw - 2 * fee : null,
    fwd_ret_3d: forward(3),
    fwd_ret_5d: forward(5),
    fwd_ret_30d: forward(30),
    entry_slippage: null,
    entry_range_pos: null,
    fill_ret_to_close: null,
    graded_at: new Date().toISOString(),
  };

  // Execution quality, measured on the day the order actually filled.
  const fillPrice = num(signal.fill_price);
  if (signal.trade_status === "filled" && Number.isFinite(fillPrice) && fillPrice > 0) {
    const side = signal.traded_side || raw;
    fields.entry_slippage = side === "SELL" ? (p0 - fillPrice) / p0 : (fillPrice - p0) / p0; // positive = worse for us
    const fd = eatDate(signal.filled_at);
    const execRow = fd ? rows.find((r) => r.date === fd) : null;
    if (execRow) {
      const hi = num(execRow.high);
      const lo = num(execRow.low);
      if (!isFlat(execRow) && hi > lo) fields.entry_range_pos = Math.min(1, Math.max(0, (fillPrice - lo) / (hi - lo)));
      fields.fill_ret_to_close = directionalReturn(side, fillPrice, num(execRow.close));
    }
  }
  return { fields };
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const pct = (v) => (v === null ? "  n/a " : (v * 100).toFixed(2).padStart(6) + "%");

export function summarize(graded, fee = 0.02) {
  const byTicker = {};
  for (const g of graded) (byTicker[g.signal.ticker] ||= []).push(g);
  const hurdle = 2 * fee;
  const lines = [];
  lines.push("ticker   n  flat%  hit%(moved)  gross-1d  gross-3d  gross-5d   net-1d   net-5d  filled  slippage  range-pos");
  const row = (name, list) => {
    const acted = list.filter((g) => g.signal.raw_action === "BUY" || g.signal.raw_action === "SELL");
    const flats = acted.filter((g) => g.fields.ret_close_to_close === 0).length;
    const moved = acted.length - flats;
    const hits = acted.filter((g) => g.fields.direction_hit === true).length;
    const g1 = mean(acted.map((g) => g.fields.shadow_return));
    const g5 = mean(acted.map((g) => g.fields.fwd_ret_5d).filter((v) => v !== null && v !== undefined));
    const g3 = mean(acted.map((g) => g.fields.fwd_ret_3d).filter((v) => v !== null && v !== undefined));
    const filled = list.filter((g) => g.fields.entry_slippage !== null);
    const pos = list.map((g) => g.fields.entry_range_pos).filter((v) => v !== null);
    lines.push(
      name.padEnd(7) +
        String(acted.length).padStart(3) + "  " +
        (acted.length ? ((flats / acted.length) * 100).toFixed(0).padStart(4) + "%" : "  n/a") + "  " +
        (moved ? ((hits / moved) * 100).toFixed(0).padStart(8) + "%" : "     n/a ") + "   " +
        pct(g1) + "  " + pct(g3) + "  " + pct(g5) + "  " +
        pct(g1 === null ? null : g1 - hurdle) + "  " +
        pct(g5 === null ? null : g5 - hurdle) + "  " +
        String(filled.length).padStart(6) + "  " +
        pct(mean(filled.map((g) => g.fields.entry_slippage))) + "  " +
        (pos.length ? mean(pos).toFixed(2).padStart(8) : "     n/a")
    );
  };
  for (const t of Object.keys(byTicker).sort()) row(t, byTicker[t]);
  row("ALL", graded);
  return lines.join("\n") + "\n\nnet = gross minus the " + (hurdle * 100).toFixed(1) + "% round-trip commission. hit%(moved) ignores days the stock closed unchanged.";
}

async function main() {
  const apply = process.argv.includes("--apply");
  const regrade = process.argv.includes("--regrade");
  const arg = (n) => process.argv.find((a) => a.startsWith("--" + n + "="))?.split("=")[1];
  const since = arg("since") || "2026-09-23";
  const fee = Number(process.env.FEE_RATE_PER_SIDE ?? 0.02);

  await import("dotenv/config");
  const { createClient } = await import("@supabase/supabase-js");
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env");
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  let q = supabase.from("daily_signals").select("*").gte("signal_date", since).order("signal_date", { ascending: true });
  if (!regrade) q = q.is("graded_at", null);
  const { data: signals, error } = await q;
  if (error) throw error;

  const names = [...new Set(Object.values(DATASET_FOR))];
  const { data: kvRows, error: kvErr } = await supabase.from("kv").select("key,value").in("key", names.map(keyOf));
  if (kvErr) throw kvErr;
  const datasets = {};
  for (const n of names) {
    const r = kvRows.find((x) => x.key === keyOf(n));
    datasets[n] = r && Array.isArray(r.value) ? r.value.slice().sort((a, b) => String(a.date).localeCompare(String(b.date))) : [];
  }

  const graded = [];
  const skipped = [];
  for (const s of signals) {
    const name = DATASET_FOR[s.ticker];
    if (!name) { skipped.push([s, "no dataset mapped for ticker " + s.ticker]); continue; }
    const res = gradeSignal(s, datasets[name], { fee });
    if (res.skip) skipped.push([s, res.skip]); else graded.push({ signal: s, fields: res.fields });
  }

  console.log(`Grading ${apply ? "(APPLY)" : "(dry run)"}: ${signals.length} signal(s) since ${since}; ${graded.length} gradable, ${skipped.length} skipped. Fee per side: ${(fee * 100).toFixed(1)}%.`);
  for (const [s, why] of skipped) console.log(`  skip ${s.ticker} ${String(s.signal_date).slice(0, 10)}: ${why}`);
  if (graded.length) console.log("\n" + summarize(graded, fee));

  if (!apply) return console.log("\nDry run only. Re-run with --apply to write the grades.");
  let written = 0;
  for (const g of graded) {
    const { error: upErr } = await supabase.from("daily_signals").update(g.fields).eq("id", g.signal.id);
    if (upErr) throw upErr;
    written++;
  }
  console.log(`\nWrote ${written} grade(s).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("[grade] Fatal error:", err.message);
    process.exitCode = 1;
  });
}
