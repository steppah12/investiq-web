// collect-market.mjs
// Collector v2. One direct API call (no browser) captures the whole Soko Play board:
// last price, open, high, low, close, previous close, volume, number of trades, VWAP, best bid,
// best ask, market cap and the paused/halted flags, for every listed stock.
//
// Storage is kept small on purpose (Supabase free tier): a row is stored only when something about
// a stock CHANGED since its last stored row, plus a heartbeat row every 30 minutes so a quiet stock
// still shows it was observed. With --final it also keeps one raw payload per day in
// market_raw_daily, so fields we do not use yet can still be used later.
//
// Raw data is append-only: this script only ever INSERTS ticks (the daily raw payload is the single
// upsert, and it only replaces the same day's earlier capture). It never edits other tables.
//
// The login token comes from the saved session file. If it is missing or about to expire, the
// script logs in once through the browser session code and carries on.
//
// Usage (from ~/investiq-web/bot):
//   node collect-market.mjs --dry-run     # show what would be stored, write nothing
//   node collect-market.mjs               # one capture
//   node collect-market.mjs --final       # one capture and the day's raw payload
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const API = "https://trading.agilebiz.co.ke/api";
const HEARTBEAT_MS = 30 * 60 * 1000;
const MIN_TOKEN_LIFE_MS = 120 * 1000;
const STATE_FILE = path.resolve("./.session/storage-state.json");

// ---------------------------------------------------------------- pure helpers (tested)
const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
export const eatDate = (ms) => new Date(ms + 3 * 3600000).toISOString().slice(0, 10);

export function toTickRow(rec, ctx) {
  const trades = num(rec.NumberOfTrades);
  return {
    captured_at: new Date(ctx.now).toISOString(),
    trade_date: eatDate(ctx.now),
    symbol_id: String(rec.SymbolId),
    issuer: rec.Issuer ?? null,
    symbol_name: rec.SymbolName ?? null,
    status: rec.SymbolStatus ?? null,
    paused: Boolean(rec.isPaused),
    halted: Boolean(rec.isHalted),
    ltp: num(rec.LastTradedPrice),
    ltq: num(rec.LastTradedQuantity),
    ltt: rec.LastTradedTime ?? null,
    open: num(rec.OpenPrice),
    high: num(rec.HighestPrice),
    low: num(rec.LowestPrice),
    close: num(rec.ClosePrice),
    prev_close: num(rec.PreviousClose),
    volume: num(rec.VolumeTraded),
    trades: trades === null ? null : Math.round(trades),
    vwap: num(rec.VWAP),
    best_bid: num(rec.HighestBuyOrderPriceOnLive),
    best_ask: num(rec.LowestSellOrderPriceOnLive),
    market_cap: num(rec.MarketCapitalization),
    issued_shares: num(rec.IssuedShares),
    market_message: ctx.marketMessage ?? null,
    market_open: ctx.marketOpen ?? null,
    heartbeat: false,
  };
}

const WATCH = ["ltp", "ltq", "ltt", "open", "high", "low", "close", "prev_close", "volume", "trades", "vwap", "best_bid", "best_ask", "paused", "halted", "status"];
// Equal when both are null, numerically equal (the database may hand numbers back as "24.0"), or the same text.
const same = (a, b) => {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  if (typeof a !== "boolean" && typeof b !== "boolean" && a !== "" && b !== "" && Number.isFinite(Number(a)) && Number.isFinite(Number(b))) return Number(a) === Number(b);
  return String(a) === String(b);
};

/** Rows worth storing: new stocks, stocks whose watched fields changed, and stale ones as heartbeats. */
export function selectRows(board, lastBySymbol, ctx) {
  const seen = new Set();
  const out = [];
  for (const rec of board) {
    const id = String(rec.SymbolId);
    if (seen.has(id)) continue; // the same SymbolId twice in one payload: keep the first
    seen.add(id);
    const row = toTickRow(rec, ctx);
    const prev = lastBySymbol.get(id);
    if (!prev) {
      out.push(row);
      continue;
    }
    if (WATCH.some((k) => !same(prev[k], row[k]))) out.push(row);
    else if (ctx.now - Date.parse(prev.captured_at) >= HEARTBEAT_MS) {
      row.heartbeat = true;
      out.push(row);
    }
  }
  return out;
}

/** The daily raw payload drops the bulky text and image fields. */
export const slim = (board) => board.map(({ CompanyLogo, CompanyDescription, ...rest }) => rest);

export function parseJwtExp(token) {
  try {
    const part = String(token).split(".")[1];
    const payload = JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return payload.exp ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

export function tokenFromState(file = STATE_FILE) {
  try {
    const s = JSON.parse(fs.readFileSync(file, "utf8"));
    const t = (s.origins || []).flatMap((o) => o.localStorage || []).find((i) => i.name === "token");
    return t && t.value ? { token: t.value, expMs: parseJwtExp(t.value) } : null;
  } catch {
    return null; // missing, or caught mid-write by a login in progress
  }
}

// ---------------------------------------------------------------- one capture (dependencies injected)
export async function collectOnce({ getToken, refreshToken, fetchJson, db, now = Date.now(), final = false, dryRun = false, log = console.log }) {
  let tok = getToken();
  if (!tok || !tok.expMs || tok.expMs - now < MIN_TOKEN_LIFE_MS) {
    log("[collect] token missing or about to expire, logging in");
    tok = await refreshToken();
  }
  let res = await fetchJson(API + "/Symbols/symbol-list", tok.token);
  if (res.status === 401) {
    log("[collect] 401 from the board call, refreshing the token once");
    tok = await refreshToken();
    res = await fetchJson(API + "/Symbols/symbol-list", tok.token);
  }
  if (res.status !== 200 || !Array.isArray(res.json) || !res.json.length) throw new Error("symbol-list failed: HTTP " + res.status);

  let marketMessage = null;
  let marketOpen = null;
  try {
    const ms = await fetchJson(API + "/Symbols/market-status", tok.token);
    if (ms.status === 200 && ms.json) {
      marketMessage = ms.json.Message ?? null;
      marketOpen = ms.json.IsMarketOpen ?? null;
    }
  } catch {}

  const last = await db.latest(); // throws on failure: without it we cannot tell what changed, so store nothing
  const rows = selectRows(res.json, last, { now, marketMessage, marketOpen });
  if (!dryRun && rows.length) await db.insertTicks(rows);
  if (final && !dryRun) await db.upsertRawDaily(eatDate(now), "symbol-list", slim(res.json), now);
  const hb = rows.filter((r) => r.heartbeat).length;
  log(`[collect] board ${res.json.length} stocks, ${rows.length} row(s) ${dryRun ? "would be stored" : "stored"} (${hb} heartbeat), market: ${marketMessage ?? "unknown"}${final ? ", raw daily payload " + (dryRun ? "skipped" : "saved") : ""}`);
  return { board: res.json.length, stored: rows.length, heartbeats: hb, marketMessage, rows };
}

// ---------------------------------------------------------------- real dependencies
function makeDb(supabase) {
  return {
    async latest() {
      const { data, error } = await supabase.from("market_latest").select("*");
      if (error) throw new Error("market_latest: " + error.message);
      return new Map((data || []).map((r) => [String(r.symbol_id), r]));
    },
    async insertTicks(rows) {
      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await supabase.from("market_ticks").insert(rows.slice(i, i + 500));
        if (error) throw new Error("insert market_ticks: " + error.message);
      }
    },
    async upsertRawDaily(date, source, payload, now) {
      const { error } = await supabase.from("market_raw_daily").upsert({ trade_date: date, source, captured_at: new Date(now).toISOString(), payload }, { onConflict: "trade_date,source" });
      if (error) throw new Error("upsert market_raw_daily: " + error.message);
    },
  };
}

async function refreshTokenViaBrowser() {
  const { launchSession } = await import("./src/session.js");
  const { browser, page } = await launchSession({ headless: true });
  try {
    const token = await page.evaluate(() => localStorage.getItem("token"));
    if (!token) throw new Error("no token after login");
    return { token, expMs: parseJwtExp(token) };
  } finally {
    await browser.close().catch(() => {});
  }
}

async function fetchJson(url, token) {
  const res = await fetch(url, { headers: { Authorization: "Bearer " + token, Accept: "application/json" } });
  let json = null;
  try {
    json = await res.json();
  } catch {}
  return { status: res.status, json };
}

async function main() {
  const argv = process.argv.slice(2);
  await import("dotenv/config");
  const { createClient } = await import("@supabase/supabase-js");
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env");
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const result = await collectOnce({
    getToken: () => tokenFromState(),
    refreshToken: refreshTokenViaBrowser,
    fetchJson,
    db: makeDb(supabase),
    final: argv.includes("--final"),
    dryRun: argv.includes("--dry-run"),
  });
  if (argv.includes("--dry-run")) {
    for (const r of result.rows.slice(0, 12)) console.log("  ", String(r.issuer).padEnd(6), "ltp", r.ltp, "bid", r.best_bid, "ask", r.best_ask, "vol", r.volume, "trades", r.trades);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(() => process.exit(0)).catch((err) => {
    console.error("[collect] Fatal error:", err.message);
    process.exit(1);
  });
}
