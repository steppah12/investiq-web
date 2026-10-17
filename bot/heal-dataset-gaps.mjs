// heal-dataset-gaps.mjs
// Fills missing weekdays in iq_stock_<name> from daily_price_archive, and
// upgrades flat close-only bars to full OHLCV rows when the archive has one.
//
// Safety rules:
//  - DRY RUN by default. Nothing is written unless you pass --apply.
//  - A weekday is only healed if at least one stock has a REAL row (volume
//    not null) for it in the dataset. That proves the market was open, so
//    holidays and weekends are never filled.
//  - Only inserts missing days or replaces flat bars. It never overwrites a
//    real row, so myStocks stays the owner of real data.
//
// Usage (from ~/investiq-web/bot):
//   node heal-dataset-gaps.mjs                       # dry run
//   node heal-dataset-gaps.mjs --from=2026-09-14     # choose the start date
//   node heal-dataset-gaps.mjs --apply               # write the changes
import { pathToFileURL } from "node:url";

export const STOCKS = {
  "Stanbic Bank": "SBIC",
  "Co-op Bank": "COOP",
  "Kenya Re": "KNRE",
  "ABSA NewGold ETF": "GLD",
  "Crown Paints": "CRWN",
};

const DAY = 86400000;
const keyOf = (name) => "iq_stock_" + name.replace(/\s+/g, "_");
const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
const isReal = (r) => r && r.volume !== null && r.volume !== undefined;

function weekdaysBetween(from, to) {
  const out = [];
  for (let t = Date.parse(from + "T00:00:00Z"); t <= Date.parse(to + "T00:00:00Z"); t += DAY) {
    const d = new Date(t);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

// Turn an archive row into a dataset row, or null if it looks wrong.
function toRow(a) {
  const [open, high, low, close] = [a.open, a.high, a.low, a.close].map(num);
  if (![open, high, low, close].every((n) => Number.isFinite(n) && n > 0)) return null;
  const volume = num(a.volume);
  if (volume !== null && !(low <= close && close <= high)) return null; // bad full row
  return { date: String(a.trade_date).slice(0, 10), open, high, low, close, volume };
}

// Best archive row per ticker+date: a full row beats a flat one, newest wins ties.
function bestArchive(archive) {
  const best = new Map();
  for (const a of archive) {
    const row = toRow(a);
    if (!row) continue;
    const k = a.ticker + "|" + row.date;
    const cur = best.get(k);
    const rank = (x) => [x.row.volume !== null ? 1 : 0, String(x.fetched_at)];
    const cand = { row, fetched_at: a.fetched_at };
    if (!cur) best.set(k, cand);
    else {
      const [rc, fc] = rank(cand);
      const [ru, fu] = rank(cur);
      if (rc > ru || (rc === ru && fc > fu)) best.set(k, cand);
    }
  }
  return best;
}

export function planHeals(datasets, archive, from, to) {
  const confirmed = new Set();
  for (const rows of Object.values(datasets))
    for (const r of rows) if (r.date >= from && r.date <= to && isReal(r)) confirmed.add(r.date);

  const best = bestArchive(archive);
  const actions = [];
  const unfixable = [];
  const unconfirmed = [];

  for (const d of weekdaysBetween(from, to)) {
    if (!confirmed.has(d)) {
      unconfirmed.push(d);
      continue;
    }
    for (const [name, ticker] of Object.entries(STOCKS)) {
      const rows = datasets[name] || [];
      const existing = rows.find((r) => r.date === d);
      const cand = best.get(ticker + "|" + d);
      if (!existing) {
        if (cand) actions.push({ stock: name, date: d, kind: "insert", row: cand.row });
        else unfixable.push({ stock: name, date: d });
      } else if (!isReal(existing) && cand && cand.row.volume !== null) {
        actions.push({ stock: name, date: d, kind: "upgrade", row: cand.row });
      }
    }
  }
  return { actions, unfixable, unconfirmed };
}

async function fetchAll(makeQuery) {
  let all = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await makeQuery().range(from, from + 999);
    if (error) throw error;
    all = all.concat(data);
    if (data.length < 1000) return all;
  }
}

async function main() {
  const apply = process.argv.includes("--apply");
  const arg = (n) => process.argv.find((a) => a.startsWith("--" + n + "="))?.split("=")[1];
  const from = arg("from") || "2026-09-14";
  const to = arg("to") || new Date(Date.now() - DAY).toISOString().slice(0, 10);

  await import("dotenv/config");
  const { createClient } = await import("@supabase/supabase-js");
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env");
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: kvRows, error } = await supabase.from("kv").select("key,value").in("key", Object.keys(STOCKS).map(keyOf));
  if (error) throw error;
  const datasets = {};
  for (const name of Object.keys(STOCKS)) {
    const row = kvRows.find((r) => r.key === keyOf(name));
    if (!row || !Array.isArray(row.value)) throw new Error("Dataset missing or not an array: " + keyOf(name));
    datasets[name] = row.value;
  }
  const archive = await fetchAll(() =>
    supabase.from("daily_price_archive").select("*").gte("trade_date", from).lte("trade_date", to).order("id")
  );

  const { actions, unfixable, unconfirmed } = planHeals(datasets, archive, from, to);
  console.log(`Heal plan ${apply ? "(APPLY)" : "(dry run)"} ${from} to ${to}; archive rows read: ${archive.length}`);
  for (const a of actions) {
    const r = a.row;
    console.log(`${a.kind.toUpperCase().padEnd(8)} ${a.stock.padEnd(17)} ${a.date}  ${r.volume === null ? "flat" : "full"}  close=${r.close} high=${r.high} low=${r.low} vol=${r.volume}`);
  }
  for (const u of unfixable) console.log(`UNFIXABLE ${u.stock} ${u.date} (market was open, no usable archive row)`);
  if (unconfirmed.length) console.log("Weekdays with no real row in any dataset, left alone: " + unconfirmed.join(" "));
  console.log(`Summary: ${actions.filter((a) => a.kind === "insert").length} inserts, ${actions.filter((a) => a.kind === "upgrade").length} upgrades, ${unfixable.length} unfixable.`);

  if (!apply) return console.log("Dry run only. Re-run with --apply to write.");
  if (!actions.length) return console.log("Nothing to write.");

  for (const name of new Set(actions.map((a) => a.stock))) {
    const mine = actions.filter((a) => a.stock === name);
    const replace = new Set(mine.map((a) => a.date));
    const merged = datasets[name].filter((r) => !replace.has(r.date)).concat(mine.map((a) => a.row));
    merged.sort((x, y) => String(x.date).localeCompare(String(y.date)));
    const { error: upErr } = await supabase.from("kv").upsert({ key: keyOf(name), value: merged, updated_at: new Date().toISOString() });
    if (upErr) throw upErr;
    console.log(`Wrote ${keyOf(name)}: ${datasets[name].length} -> ${merged.length} rows`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("[heal] Fatal error:", err.message);
    process.exitCode = 1;
  });
}
