// health-check.mjs
// Watchdog for the whole bot. It exists because the bot was silently down from Monday 26 Oct 11:01
// to Thursday night (a zero-byte session file) and nothing noticed for three and a half days.
//
// It does NOT log in to Soko Play. It only looks at evidence the jobs leave behind, so it keeps
// working when everything else is broken:
//   - the saved session file exists and parses            (any day)
//   - free disk space                                       (any day)
//   - on a trading day, by the time each job should have run:
//       hourly price checks logged a success, the trade run logged rows, the EOD close succeeded,
//       the reconcile ran, and the market collector stored data in the last few minutes
// Every run is saved to bot_health. If ALERT_WEBHOOK_URL is set in .env (for example a private
// ntfy.sh topic URL), a failure sends a phone notification once, repeats every six hours while it
// persists, and says when things recover.
//
// Usage (from ~/investiq-web/bot):
//   node health-check.mjs --dry-run     # print the verdict, save and send nothing
//   node health-check.mjs               # print, save, alert if needed
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DAY = 86400000;
const STATE_FILE = path.resolve("./.session/storage-state.json");
const ALERT_STATE = path.resolve("./.cache/health-last.json");
const REPEAT_ALERT_MS = 6 * 3600000;

// ---------------------------------------------------------------- time helpers (EAT = UTC+3)
export const eatMinutes = (ms) => {
  const d = new Date(ms + 3 * 3600000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};
export const eatDate = (ms) => new Date(ms + 3 * 3600000).toISOString().slice(0, 10);
export const eatDayStartUtc = (ms) => new Date(Date.parse(eatDate(ms) + "T00:00:00Z") - 3 * 3600000);
const hm = (h, m = 0) => h * 60 + m;

export function isTradingDay(ms, holidays = []) {
  const dow = new Date(ms + 3 * 3600000).getUTCDay();
  return dow >= 1 && dow <= 5 && !holidays.includes(eatDate(ms));
}

export function sessionFileOk(file = STATE_FILE) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    if (!raw.trim()) return { ok: false, detail: "file is empty" };
    JSON.parse(raw);
    return { ok: true, detail: "file parses" };
  } catch (e) {
    return { ok: false, detail: e.code === "ENOENT" ? "file is missing" : "file is unreadable (" + String(e.message).split("\n")[0] + ")" };
  }
}

export function diskFreeBytes(dir = ".") {
  try {
    const s = fs.statfsSync(dir);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- the checks (pure, tested)
const LEVEL = { ok: 0, warn: 1, fail: 2 };

/**
 * input: { now, trading, session: {ok, detail}, diskFree, rows: today's bot_run_log rows [{run_type,status}],
 *          lastTickAt (ms or null), tickEver (bool) }
 */
export function evaluateHealth({ now, trading, session, diskFree, rows = [], lastTickAt = null, tickEver = false }) {
  const checks = [];
  const add = (name, level, detail) => checks.push({ name, level, detail });
  const t = eatMinutes(now);

  add("session_file", session.ok ? "ok" : "fail", session.detail);
  if (diskFree === null) add("disk_space", "warn", "could not read free space");
  else {
    const gb = diskFree / 1e9;
    add("disk_space", gb < 0.5 ? "fail" : gb < 2 ? "warn" : "ok", gb.toFixed(1) + " GB free");
  }

  if (!trading) {
    add("trading_day", "ok", "not a trading day: job checks skipped");
  } else {
    const by = (type) => rows.filter((r) => r.run_type === type);
    const hourly = rows.filter((r) => !["trade", "eod", "reconcile"].includes(r.run_type));
    const ok = (list) => list.filter((r) => r.status === "success").length;

    if (t >= hm(6, 30)) add("reconcile_today", by("reconcile").length ? "ok" : "warn", by("reconcile").length + " reconcile row(s) today");
    if (t >= hm(10, 25)) {
      add("hourly_today", ok(hourly) ? "ok" : "fail", ok(hourly) + " successful hourly price reading(s) today");
      add("trade_today", by("trade").length ? "ok" : "fail", by("trade").length + " trade-run row(s) today");
    }
    if (t >= hm(15, 55)) add("eod_today", ok(by("eod")) ? "ok" : "fail", ok(by("eod")) + " successful EOD close(s) today");
    if (t >= hm(9, 20) && t <= hm(15, 10)) {
      if (lastTickAt === null) add("collector_fresh", tickEver ? "fail" : "warn", tickEver ? "no tick stored today" : "collector has not stored anything yet");
      else {
        const age = Math.round((now - lastTickAt) / 60000);
        add("collector_fresh", age <= 20 ? "ok" : age <= 45 ? "warn" : "fail", "last tick " + age + " min ago");
      }
    }
  }
  const status = checks.reduce((s, c) => (LEVEL[c.level] > LEVEL[s] ? c.level : s), "ok");
  return { status, checks };
}

export const failing = (r) => r.checks.filter((c) => c.level !== "ok");
export const summaryLine = (r) => (r.status === "ok" ? "all checks passed" : failing(r).map((c) => c.name + ": " + c.detail).join("; "));

/** Alert on a new problem, on a change of problem, every 6 h while it lasts, and once on recovery. */
export function shouldAlert(result, last, now) {
  const key = failing(result).map((c) => c.name + ":" + c.level).sort().join(",");
  const lastKey = last && last.key ? last.key : "";
  if (result.status === "ok") return lastKey ? { send: true, kind: "recovered", key } : { send: false, key };
  if (key !== lastKey) return { send: true, kind: "problem", key };
  if (now - (last.at || 0) >= REPEAT_ALERT_MS) return { send: true, kind: "still failing", key };
  return { send: false, key };
}

// ---------------------------------------------------------------- one run (dependencies injected)
export async function runHealth({ now = Date.now(), holidays = [], db, session = sessionFileOk(), diskFree = diskFreeBytes(), readLast, writeLast, send, dryRun = false, log = console.log }) {
  const trading = isTradingDay(now, holidays);
  const rows = trading ? await db.botRowsToday(eatDayStartUtc(now).toISOString()) : [];
  const tick = trading ? await db.latestTick() : { lastTickAt: null, tickEver: false };
  const result = evaluateHealth({ now, trading, session, diskFree, rows, lastTickAt: tick.lastTickAt, tickEver: tick.tickEver });
  for (const c of result.checks) log(`[health] ${c.level.toUpperCase().padEnd(4)} ${c.name}: ${c.detail}`);
  log(`[health] overall: ${result.status.toUpperCase()}`);
  if (dryRun) return { result, alerted: false };

  await db.saveHealth({ status: result.status, summary: summaryLine(result), checks: result.checks });
  const decision = shouldAlert(result, readLast(), now);
  if (decision.send) {
    const text = decision.kind === "recovered" ? "InvestIQ bot is healthy again." : `InvestIQ bot ${result.status.toUpperCase()} (${decision.kind}): ${summaryLine(result)}`;
    await send(text, result.status);
    writeLast({ key: decision.key, at: now });
  } else if (result.status !== "ok") writeLast({ key: decision.key, at: (readLast() || {}).at || now });
  return { result, alerted: decision.send };
}

// ---------------------------------------------------------------- real dependencies
function makeDb(supabase) {
  return {
    async botRowsToday(sinceIso) {
      const { data, error } = await supabase.from("bot_run_log").select("run_type,status,ran_at").gte("ran_at", sinceIso).limit(1000);
      if (error) throw new Error("bot_run_log: " + error.message);
      return data || [];
    },
    async latestTick() {
      const { data, error } = await supabase.from("market_ticks").select("captured_at").order("captured_at", { ascending: false }).limit(1);
      if (error) throw new Error("market_ticks: " + error.message);
      const row = (data || [])[0];
      if (!row) return { lastTickAt: null, tickEver: false };
      const at = Date.parse(row.captured_at);
      return { lastTickAt: eatDate(at) === eatDate(Date.now()) ? at : null, tickEver: true };
    },
    async saveHealth(row) {
      const { error } = await supabase.from("bot_health").insert(row);
      if (error) throw new Error("bot_health: " + error.message);
    },
  };
}

const fetchRetry = async (u, o) => { try { return await fetch(u, { ...o, signal: AbortSignal.timeout(15000) }); } catch { await new Promise((r) => setTimeout(r, 5000)); return fetch(u, { ...o, signal: AbortSignal.timeout(15000) }); } };
async function sendWebhook(text, status) {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return console.log("[health] ALERT (no ALERT_WEBHOOK_URL set, so nothing sent): " + text);
  const res = await fetchRetry(url, { method: "POST", body: text, headers: { Title: "InvestIQ bot " + status.toUpperCase(), Priority: status === "fail" ? "high" : "default", Tags: status === "ok" ? "white_check_mark" : "warning" } });
  console.log("[health] alert sent, HTTP " + res.status);
}

const readLast = () => {
  try {
    return JSON.parse(fs.readFileSync(ALERT_STATE, "utf8"));
  } catch {
    return null;
  }
};
const writeLast = (v) => {
  fs.mkdirSync(path.dirname(ALERT_STATE), { recursive: true });
  fs.writeFileSync(ALERT_STATE, JSON.stringify(v));
};

function readHolidays() {
  try {
    return fs.readFileSync("holidays.txt", "utf8").split(/\r?\n/).map((s) => s.trim()).filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s));
  } catch {
    return [];
  }
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  await import("dotenv/config");
  const { createClient } = await import("@supabase/supabase-js");
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env");
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { result } = await runHealth({ holidays: readHolidays(), db: makeDb(supabase), readLast, writeLast, send: sendWebhook, dryRun });
  process.exitCode = result.status === "fail" ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(() => process.exit(process.exitCode ?? 0)).catch((err) => {
    console.error("[health] Fatal error:", err.message);
    process.exit(2);
  });
}
