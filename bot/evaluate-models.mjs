// evaluate-models.mjs
// Fee-aware, out-of-sample check of the REAL engine (src/lib/liveLab/engine.ts), per stock.
//
// For each stock it retrains the engine's 30-trading-day model on a rolling window, predicts
// the days that follow (never seen in training), then compares each prediction with what the
// price really did 30 trading days later. The question it answers: does the model's BUY signal
// beat simply buying on a random day, and does it clear Soko Play's commission?
//
// Verdicts (per stock):
//   TRADE              the BUY signal beats the any-day baseline by a statistically meaningful
//                      margin, also in the last two years, AND clears the fee hurdle
//   DRIFT_ONLY         the market's drift alone clears the fees, but the model adds nothing
//   NO_EDGE            no demonstrated edge
//   INSUFFICIENT_DATA  too little history or too few BUY signals to judge
//
// DRY RUN by default (prints a report). --save writes the verdicts to model_verdicts.
// Measuring only: it never places orders and never changes the engine or the datasets.
//
// Usage (from ~/investiq-web/bot):
//   node evaluate-models.mjs --fast            # quick sanity run (about 1-2 minutes)
//   node evaluate-models.mjs                   # full run (about 5 minutes)
//   node evaluate-models.mjs --save            # full run and store the verdicts
//   node evaluate-models.mjs --tickers=SBIC,COOP
//   node evaluate-models.mjs --horizon=90     # research: judge the 90-day model instead of the live 30-day one
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";

export const STOCKS = {
  SBIC: "Stanbic Bank",
  COOP: "Co-op Bank",
  KNRE: "Kenya Re",
  GLD: "ABSA NewGold ETF",
  BERG: "Crown Paints",
};

export const HORIZON = 30; // trading days: the live signal comes from the engine's m30 model
export const FEE_ROUND_TRIP = 4.0; // percent: Soko Play charges 2% each way
export const SLIPPAGE = 0.5; // percent: rough average adverse entry slippage seen so far
const MIN_BUY_SIGNALS = 30;
const MIN_EDGE_POINTS = 1.0;
const MIN_T = 2.0;
const DAY = 86400000;

// ---------------------------------------------------------------- statistics (pure, tested)
export const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
export const variance = (a) => {
  if (a.length < 2) return NaN;
  const m = mean(a);
  return a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1);
};
export function corr(a, b) {
  if (a.length < 3) return NaN;
  const ma = mean(a), mb = mean(b);
  let n = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) {
    n += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da && db ? n / Math.sqrt(da * db) : NaN;
}

const isRawBuy = (s) => s.pUp >= s.pDown && s.pUp >= (s.pFlat ?? 0); // same rule the bot's raw_action uses

/**
 * samples: [{ date, pred, pUp, pDown, pFlat, real }]  (real = realised 30-day return in percent)
 * step = spacing in rows between samples, horizon = rows ahead; together they set how much the
 * 30-day outcomes overlap, which sets the effective sample size.
 */
export function summarize(samples, { fee = FEE_ROUND_TRIP, slip = SLIPPAGE, step = 5, horizon = HORIZON } = {}) {
  const hurdle = fee + slip;
  const neff = (n) => Math.max(1, (n * step) / horizon);
  const all = samples.map((s) => s.real);
  const buys = samples.filter(isRawBuy);
  const buyR = buys.map((s) => s.real);
  const allMean = mean(all);
  const buyMean = mean(buyR);
  const edge = buyMean - allMean;
  const se = Math.sqrt(variance(buyR) / neff(buyR.length) + variance(all) / neff(all.length));
  const t = Number.isFinite(se) && se > 0 ? edge / se : NaN;

  const lastDate = samples.length ? samples[samples.length - 1].date : null;
  const cutoff = lastDate ? new Date(Date.parse(lastDate) - 730 * DAY).toISOString().slice(0, 10) : null;
  const recent = cutoff ? samples.filter((s) => s.date >= cutoff) : [];
  const recentBuys = recent.filter(isRawBuy);
  const recentEdge = recentBuys.length >= 5 ? mean(recentBuys.map((s) => s.real)) - mean(recent.map((s) => s.real)) : NaN;

  const buyNet = buyMean - hurdle;
  const c = corr(samples.map((s) => s.pred), all);
  const strong = samples.filter((s) => s.pUp > 0.55).map((s) => s.real);

  let verdict;
  if (samples.length < 100 || buys.length < MIN_BUY_SIGNALS) verdict = "INSUFFICIENT_DATA";
  else if (edge >= MIN_EDGE_POINTS && t >= MIN_T && recentEdge > 0 && buyNet > 0 && c > 0) verdict = "TRADE";
  else if (allMean - hurdle > 0) verdict = "DRIFT_ONLY";
  else verdict = "NO_EDGE";

  return {
    n_predictions: samples.length,
    n_buy: buys.length,
    n_eff_buy: Math.round(neff(buys.length) * 10) / 10,
    buy_mean: buyMean,
    all_mean: allMean,
    edge,
    edge_t: t,
    buy_net: buyNet,
    corr_pred_real: c,
    strong_buy_mean: mean(strong),
    recent_n_buy: recentBuys.length,
    recent_edge: recentEdge,
    horizon,
    first_date: samples.length ? samples[0].date : null,
    last_date: lastDate,
    verdict,
  };
}

// ---------------------------------------------------------------- data preparation
/** Mark a trading-day hole of more than 10 calendar days, so no label or prediction spans it. */
export function markGaps(rows, maxGapDays = 10) {
  for (let i = 1; i < rows.length; i++) {
    const gap = (Date.parse(rows[i].date) - Date.parse(rows[i - 1].date)) / DAY;
    if (gap > maxGapDays) rows[i]._boundary = true;
  }
  return rows;
}

function quiet(fn) {
  const l = console.log, w = console.warn, e = console.error;
  console.log = console.warn = console.error = () => {};
  try {
    return fn();
  } finally {
    console.log = l;
    console.warn = w;
    console.error = e;
  }
}

/**
 * Out-of-sample loop: retrain on a rolling window, predict the following rows, then look 30 rows
 * ahead for the realised return. Features are built once over the series, as the engine does.
 */
export function collectSamples(engine, name, rows, feats, { win = 500, stepCut = 150, stepEval = 5, start = 1000, horizon = HORIZON } = {}) {
  const samples = [];
  for (let cut = start; cut < rows.length - horizon - 1; cut += stepCut) {
    const lo = Math.max(0, cut - win);
    const g = quiet(() => engine.trainModelsGuarded(rows.slice(lo, cut), feats.slice(lo, cut), horizon, null, null));
    if (!g || !g.model) continue;
    for (let i = cut; i < Math.min(cut + stepCut, rows.length - horizon); i += stepEval) {
      if (rows[i]._boundary || rows[i + horizon]._boundary) continue;
      const pred = quiet(() => engine.generatePredictionGuarded({ rows: rows.slice(0, i + 1), features: feats.slice(0, i + 1), models: { m30: g.model }, name }, null, {}));
      if (!pred || pred.pctTarget30 == null) continue;
      const pUp = pred.probUp ?? 0, pDown = pred.probDown ?? 0;
      samples.push({
        date: rows[i].date,
        pred: pred.pctTarget30,
        pUp,
        pDown,
        pFlat: pred.probFlat ?? Math.max(0, 1 - pUp - pDown),
        real: ((rows[i + horizon].close - rows[i].close) / rows[i].close) * 100,
      });
    }
  }
  return samples;
}

/** Load one stock exactly like the live pipeline does (engine store, then loadStockData), then evaluate. */
export function evaluateDataset(engine, name, rawRows, opts = {}) {
  engine.hydrateEngineStore({ [engine.STOCK_KEY(name)]: rawRows });
  const data = quiet(() => engine.loadStockData(name));
  if (!data) return { samples: [], summary: summarize([]), rows: 0 };
  const rows = markGaps(data.rows.filter((r) => r.date >= "2013-01-01"));
  const offset = data.rows.length - rows.length; // rows dropped from the front; features stay aligned
  const feats = data.features.slice(offset);
  const horizon = opts.horizon ?? HORIZON;
  const samples = collectSamples(engine, name, rows, feats, { ...opts, horizon });
  return { samples, summary: summarize(samples, { step: opts.stepEval ?? 5, horizon }), rows: rows.length };
}

// ---------------------------------------------------------------- engine build
const HERE = path.dirname(fileURLToPath(import.meta.url));

export async function loadEngine() {
  const src = process.env.INVESTIQ_ENGINE_SRC || path.resolve(HERE, "../src/lib/liveLab/engine.ts");
  const out = path.resolve(HERE, ".cache/engine.mjs");
  if (!fs.existsSync(src)) throw new Error("Engine source not found: " + src);
  const stale = !fs.existsSync(out) || fs.statSync(out).mtimeMs < fs.statSync(src).mtimeMs;
  if (stale) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const local = [path.resolve(HERE, "node_modules/.bin/esbuild"), path.resolve(HERE, "../node_modules/.bin/esbuild")].find((p) => fs.existsSync(p));
    const args = [src, "--format=esm", "--outfile=" + out, "--log-level=warning"];
    console.log("[evaluate] Transpiling the engine (" + (local ? "local esbuild" : "npx esbuild") + ")...");
    if (local) execFileSync(local, args, { stdio: "inherit" });
    else execFileSync("npx", ["--yes", "esbuild", ...args], { stdio: "inherit" });
  }
  return import(pathToFileURL(out).href + "?v=" + fs.statSync(out).mtimeMs);
}

// ---------------------------------------------------------------- report and main
const f = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : "n/a");

export function formatReport(results) {
  const lines = ["ticker  verdict            BUY-n  BUY mean  any-day  edge(pts)    t   corr   recent-edge  net-of-fees"];
  for (const r of results) {
    const s = r.summary;
    lines.push(
      r.ticker.padEnd(7) + " " + s.verdict.padEnd(18) + String(s.n_buy).padStart(5) + "  " +
        (f(s.buy_mean) + "%").padStart(8) + "  " + (f(s.all_mean) + "%").padStart(7) + "  " +
        f(s.edge).padStart(8) + "  " + f(s.edge_t, 1).padStart(4) + "  " + f(s.corr_pred_real, 3).padStart(6) + "  " +
        f(s.recent_edge).padStart(11) + "  " + (f(s.buy_net) + "%").padStart(10)
    );
  }
  lines.push("");
  lines.push((results[0]?.summary?.horizon ?? HORIZON) + "-trading-day returns, before fees unless marked net. net-of-fees = BUY mean minus " + (FEE_ROUND_TRIP + SLIPPAGE).toFixed(1) + "% (" + FEE_ROUND_TRIP + "% commission + " + SLIPPAGE + "% slippage).");
  lines.push("edge = BUY mean minus the any-day mean over the same period; t uses the effective sample size because the windows overlap.");
  return lines.join("\n");
}

async function main() {
  const argv = process.argv.slice(2);
  const save = argv.includes("--save");
  const fast = argv.includes("--fast");
  const arg = (n) => argv.find((a) => a.startsWith("--" + n + "="))?.split("=")[1];
  const want = (arg("tickers") || Object.keys(STOCKS).join(",")).split(",").map((s) => s.trim().toUpperCase());
  const horizon = Number(arg("horizon") || HORIZON);
  if (![30, 60, 90].includes(horizon)) throw new Error("--horizon must be 30, 60 or 90");
  const opts = { ...(fast ? { stepCut: 300, stepEval: 10 } : { stepCut: 150, stepEval: 5 }), horizon };

  await import("dotenv/config");
  const { createClient } = await import("@supabase/supabase-js");
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env");
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const engine = await loadEngine();

  const results = [];
  for (const ticker of want) {
    const name = STOCKS[ticker];
    if (!name) { console.log("[evaluate] unknown ticker " + ticker); continue; }
    const key = engine.STOCK_KEY(name);
    const { data, error } = await supabase.from("kv").select("value").eq("key", key).maybeSingle();
    if (error) throw error;
    if (!data || !Array.isArray(data.value)) { console.log("[evaluate] no dataset for " + name); continue; }
    const t0 = Date.now();
    const r = evaluateDataset(engine, name, data.value, opts);
    console.log(`[evaluate] ${ticker} (${name}): ${r.rows} rows, ${r.samples.length} out-of-sample predictions in ${((Date.now() - t0) / 1000).toFixed(0)}s -> ${r.summary.verdict}`);
    results.push({ ticker, name, summary: r.summary });
  }

  console.log("\n" + formatReport(results));
  if (!save) return console.log("\nDry run only. Re-run with --save to store the verdicts.");

  const rows = results.map(({ ticker, name, summary: s }) => ({
    ticker, stock_name: name, data_through: s.last_date, horizon,
    fee_round_trip: FEE_ROUND_TRIP, slippage: SLIPPAGE,
    n_predictions: s.n_predictions, n_buy: s.n_buy, n_eff_buy: s.n_eff_buy,
    buy_mean: num(s.buy_mean), all_mean: num(s.all_mean), edge: num(s.edge), edge_t: num(s.edge_t),
    buy_net: num(s.buy_net), corr_pred_real: num(s.corr_pred_real),
    recent_n_buy: s.recent_n_buy, recent_edge: num(s.recent_edge),
    verdict: s.verdict, details: s,
  }));
  const { error } = await supabase.from("model_verdicts").insert(rows);
  if (error) throw error;
  console.log(`\nSaved ${rows.length} verdict(s) to model_verdicts.`);
}

const num = (v) => (Number.isFinite(v) ? v : null);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("[evaluate] Fatal error:", err.message);
    process.exitCode = 1;
  });
}
