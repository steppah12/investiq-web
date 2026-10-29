// recon-market-data.mjs
// READ-ONLY reconnaissance for the data collector. Places no orders and writes nothing to the
// database. It opens Soko Play's market watch page and one stock's detail page and reports:
//   - which API calls the pages make (path and query parameter names only)
//   - for market-data calls only: the JSON shape and one sample record, so we can see every field
//     Soko Play exposes (high, low, volume, bid, ask, ...) and whether ONE call returns the whole board
//   - what the pages show on screen (table headers, row counts, the first lines of text)
// Account endpoints (wallet, orders, profile) are listed but their bodies are never printed.
// A full copy of what it saw is written to logs/recon-<time>.json on this machine only.
//
// Usage (from ~/investiq-web/bot; avoid :00-:03, :10-:13 and :35-:40, when cron jobs log in):
//   node recon-market-data.mjs 2>&1 | cut -c1-220 | head -400
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const API_HOST = /agilebiz\.co\.ke/i;
const MARKETY = /symbol|market|stock|price|quote|watch|ticker|instrument|security|depth|book|trade|news|analytic|histor|chart|ohlc|candle|equity|equities|derivative|bond|yield|index/i;
const PRIVATE = /wallet|balance|account|profile|user|login|auth|token|password|portfolio|holding|competition|orders?\/(matched|pending|create|cancel|history|my)|matchedorders|pendingorders|myorders/i;

const pathname = (url) => {
  try {
    return new URL(url).pathname;
  } catch {
    return String(url);
  }
};
export const isApi = (url) => API_HOST.test(url);
// Judged on the path only, so a query parameter such as CompetitionId does not hide a market-data call.
export const showBody = (url) => isApi(url) && MARKETY.test(pathname(url)) && !PRIVATE.test(pathname(url));

export function pathOf(url) {
  try {
    const u = new URL(url);
    const keys = [...new Set([...u.searchParams.keys()])];
    return u.pathname + (keys.length ? "?" + keys.join("&") : "");
  } catch {
    return String(url).slice(0, 120);
  }
}

/** Compact description of a JSON value: object keys with types, arrays as [N x first element]. */
export function shape(v, depth = 0) {
  if (v === null) return "null";
  if (Array.isArray(v)) return v.length ? `[${v.length} x ${shape(v[0], depth + 1)}]` : "[]";
  if (typeof v === "object") {
    if (depth >= 3) return "{...}";
    return "{" + Object.entries(v).slice(0, 40).map(([k, x]) => k + ": " + shape(x, depth + 1)).join(", ") + "}";
  }
  return typeof v;
}

/** One representative record: the first array element if the body is (or wraps) an array. */
export function sample(v) {
  if (Array.isArray(v)) return v[0];
  if (v && typeof v === "object") {
    for (const val of Object.values(v)) if (Array.isArray(val) && val.length && typeof val[0] === "object") return val[0];
  }
  return v;
}

const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n) + " ...[cut]" : String(s));

async function snapshotPage(page) {
  const text = await page.locator("body").innerText().catch(() => "");
  const headers = await page.locator("th").allInnerTexts().catch(() => []);
  const rows = await page.locator("tr, [role=row]").count().catch(() => 0);
  const raw = await page
    .locator("a[href]")
    .evaluateAll((els) => els.map((e) => ({ text: (e.innerText || "").trim().replace(/\s+/g, " "), href: e.href })))
    .catch(() => []);
  const seen = new Set();
  const links = raw.filter((l) => l.text && /academy\.nse\.co\.ke/i.test(l.href) && !seen.has(l.href) && seen.add(l.href)).slice(0, 60);
  return { url: page.url(), headers: headers.map((h) => h.trim()).filter(Boolean), rows, links, text: clip(text.replace(/\n{2,}/g, "\n"), 1800) };
}

function report(say, title, calls, snap) {
  say("\n==== " + title + " ====");
  say("page: " + snap.url);
  say("table headers (" + snap.headers.length + "): " + (snap.headers.join(" | ") || "none found"));
  say("table rows on screen: " + snap.rows);
  if (snap.links && snap.links.length && title.startsWith("1.")) {
    say("-- menu links --");
    for (const l of snap.links) say("   " + l.text.slice(0, 40).padEnd(40) + " " + pathOf(l.href));
  }
  const seen = new Set();
  say("-- API calls made by this page --");
  for (const c of calls) {
    const key = c.method + " " + c.path;
    if (seen.has(key)) continue;
    seen.add(key);
    say(`${c.method} ${c.status} ${c.path}${c.bodyShown ? "   [market data]" : ""}`);
    if (c.bodyShown && c.json !== undefined) {
      say("   shape:  " + clip(shape(c.json), 900));
      say("   sample: " + clip(JSON.stringify(sample(c.json)), 700));
    }
  }
  say("-- what the page shows (first lines) --");
  say(snap.text);
}

/**
 * deps: { page, openPicker, findRow, say, wait, stock }
 * Everything environment-specific is injected so the logic can be tested without a browser.
 */
export async function runRecon({ page, openPicker, findRow, say = console.log, wait = (ms) => page.waitForTimeout(ms), stock = "Stanbic Holdings" }) {
  const calls = [];
  page.on("response", async (res) => {
    const url = res.url();
    if (!isApi(url)) return;
    const rec = { method: res.request().method(), status: res.status(), path: pathOf(url), bodyShown: false };
    const ctype = (res.headers()["content-type"] || "").toLowerCase();
    if (showBody(url) && ctype.includes("json") && res.status() === 200) {
      try {
        rec.json = JSON.parse(await res.text());
        rec.bodyShown = true;
      } catch {}
    }
    calls.push(rec);
  });

  await page.goto("https://academy.nse.co.ke/trader/marketwatch", { waitUntil: "domcontentloaded" });
  await wait(7000);
  const mwSnap = await snapshotPage(page);
  const mwCalls = calls.splice(0, calls.length);
  report(say, "1. market watch page", mwCalls, mwSnap);

  await page.goto("https://academy.nse.co.ke/trader/dashboard", { waitUntil: "domcontentloaded" });
  const modal = await openPicker(page);
  const row = await findRow(modal, stock);
  await row.click();
  await page.waitForURL(/\/trader\/stock\/\d+/, { timeout: 10000 });
  await wait(7000);
  const sdSnap = await snapshotPage(page);
  const sdCalls = calls.splice(0, calls.length);
  report(say, "2. stock detail page (" + stock + ")", sdCalls, sdSnap);

  // Menu pages that might hold price history, news or analytics (Contests is skipped: other people's names).
  // The sidebar is a single-page app menu without ordinary links, so each item is reached by clicking its label.
  const extra = [];
  let n = 3;
  for (const label of ["Equity Prices", "Analytics", "News", "Derivatives"]) {
    try {
      await page.goto("https://academy.nse.co.ke/trader/marketwatch", { waitUntil: "domcontentloaded" });
      await wait(2500);
      calls.splice(0, calls.length);
      await page.getByText(label, { exact: true }).first().click({ timeout: 8000 });
      await wait(7000);
      const snap = await snapshotPage(page);
      const calls2 = calls.splice(0, calls.length);
      report(say, n + ". " + label + " page", calls2, snap);
      extra.push({ title: label, snap, calls: calls2 });
    } catch (err) {
      calls.splice(0, calls.length);
      say("\n==== " + n + ". " + label + " page: could not open (" + String(err.message).split("\n")[0] + ")");
    }
    n++;
  }

  return { marketWatch: { snap: mwSnap, calls: mwCalls }, stockDetail: { snap: sdSnap, calls: sdCalls }, extra };
}

async function main() {
  const { launchSession } = await import("./src/session.js");
  const { openStockPickerModal, findStockRow } = await import("./src/trade.js");
  const { browser, page } = await launchSession({ headless: true });
  try {
    const result = await runRecon({ page, openPicker: openStockPickerModal, findRow: findStockRow });
    fs.mkdirSync("logs", { recursive: true });
    const file = path.join("logs", "recon-" + new Date().toISOString().replace(/[:.]/g, "-") + ".json");
    fs.writeFileSync(file, JSON.stringify(result, null, 1));
    console.log("\nFull copy saved to " + file + " (stays on this machine).");
  } finally {
    await browser.close().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(() => process.exit(0)).catch((err) => {
    console.error("[recon] Fatal error:", err.message);
    process.exit(1);
  });
}
