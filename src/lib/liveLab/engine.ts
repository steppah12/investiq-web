// @ts-nocheck
//
// ⚠️ MECHANICALLY EXTRACTED FROM src/app/InvestIQApp.tsx — DO NOT HAND-EDIT
// THE ALGORITHM LOGIC BELOW.
//
// Every function/class from "buildFeaturesForStock" through
// "generatePredictionGuarded" (feature engineering, GBDT/LogReg/LinReg
// models, walk-forward backtesting, prediction generation) plus their
// supporting utilities are copied byte-for-byte from the client app via
// `sed` — not retyped — specifically to avoid the risk of the server-side
// pipeline silently drifting from what your manual "Retrain"/backtest
// button actually does in the browser.
//
// The ONLY thing that's different here is the storage backend: the
// original code calls a synchronous `db.save`/`db.load`/`db.remove`/`db.keys`
// object (originally backed by localStorage in the browser). Here it's
// backed by a plain in-memory Map instead — same synchronous interface, so
// none of the extracted algorithm code below needed to change at all.
// hydrateEngineStore() / dumpEngineStore() let the caller (nseSync.ts's
// pipeline) load real data in from Supabase before running, and persist
// results back out after.
//
// If you ever change the training/backtest/prediction logic in
// InvestIQApp.tsx, re-run the same extraction (see the comment block in
// nseSync.ts's pipeline for the exact sed commands) so this file and the
// browser never disagree.

// ─── In-memory synchronous storage backend (replaces localStorage) ─────────
const _store = new Map();

export function hydrateEngineStore(records) {
  _store.clear();
  for (const [k, v] of Object.entries(records || {})) _store.set(k, v);
}

export function dumpEngineStore() {
  return Object.fromEntries(_store.entries());
}

export function getEngineStoreKeys(prefix = "") {
  return Array.from(_store.keys()).filter((k) => k.startsWith(prefix));
}

const db = {
  save(k, v) {
    // Deep-clone on write too, so later mutations to the caller's object
    // can't silently alter what's "stored" without going through save()
    // again — matches localStorage (which only ever stores a string).
    _store.set(k, JSON.parse(JSON.stringify(v)));
    return true;
  },
  load(k, fb = null) {
    if (!_store.has(k)) return fb;
    // Fresh copy every call — mirrors localStorage.getItem + JSON.parse,
    // which always produces a brand new object. Without this, mutating a
    // loaded array/object (e.g. rows.push(...)) would silently mutate the
    // "stored" value before any save() call, which is not how the real
    // browser db object behaves.
    return JSON.parse(JSON.stringify(_store.get(k)));
  },
  remove(k) {
    _store.delete(k);
  },
  keys(prefix = "") {
    return Array.from(_store.keys()).filter((key) => key.startsWith(prefix));
  },
};

function hasAdminRole() { return true; }

// ─── Everything below this line is copied verbatim (sed 526,584p + 618,3453p
// InvestIQApp.tsx) — do not hand-edit. ───────────────────────────────────────

const MAX_STORAGE_BYTES = 4_500_000;

// U4: Ensemble weights — GBDT gets the most weight (nonlinear, more powerful)
const ENSEMBLE_WEIGHTS = { logreg: 0.25, gbdt: 0.45, pattern: 0.30 };
// U3: Default deadband per horizon (% move required to label as UP or DOWN)
const DEFAULT_DEADBAND = { 30: 2.0, 60: 3.5, 90: 5.0 };
// Deadband is now a FLOOR, not the actual threshold used during training.
// The actual threshold is auto-calibrated per stock — see calibrateDeadband().

// ─── AUTO-CALIBRATING DEADBAND ─────────────────────────────────────────────
// Computes the deadband that produces ~targetFlatPct FLAT labels for this stock.
// This prevents the 65%-FLAT collapse seen on low-volatility or short datasets.
// Uses binary search on the horizon returns distribution.
function calibrateDeadband(rows, horizon, targetFlatPct=0.30) {
  if(!rows || rows.length < horizon + 30) return DEFAULT_DEADBAND[horizon] ?? 2.0;

  // Collect all raw returns for this horizon
  const returns = [];
  for(let i=50; i<rows.length-horizon; i++){
    if(rows[i]?._boundary || rows[i+horizon]?._boundary) continue;
    const ret = (rows[i+horizon].close - rows[i].close) / rows[i].close * 100;
    if(isFinite(ret)) returns.push(Math.abs(ret));
  }
  if(returns.length < 20) return DEFAULT_DEADBAND[horizon] ?? 2.0;

  returns.sort((a,b)=>a-b);

  // The deadband is the Nth percentile of |returns| where N = targetFlatPct/2
  // (symmetric: half flat below threshold, half above in reverse)
  // We want ~30% flat: that means top 35% UP, bottom 35% DOWN, middle 30% FLAT
  // So deadband = the value at the 35th percentile of |returns|
  const upFlatPct = targetFlatPct / 2; // each tail gets half the flat budget
  const targetPct = 1 - upFlatPct;     // 85th percentile of |returns|... wait
  // Actually: FLAT = |ret| < band. We want flatPct rows to have |ret| < band.
  // So band = targetFlatPct-th percentile of |returns|.
  const idx = Math.floor(targetFlatPct * returns.length);
  const band = returns[Math.min(idx, returns.length-1)];

  // Floor: 0.5% minimum — low enough to let auto-calibration work on short
  // datasets (e.g. 1yr / 261 rows). The 2.0% floor was causing 65% FLAT labels.
  // Transaction cost filtering is handled by the strategy return calculator,
  // not by the deadband — they serve different purposes.
  return Math.max(0.5, Math.min(band, 15.0));
}

// ─── BACKEND MIGRATION GUIDE ────────────────────────────────────────────────
// All data access goes through the `db` object. To migrate to Supabase:
// 1. Replace each db method body with the annotated Supabase call below.
// 2. Make db methods async and await all callers.
// 3. Data schema: kv(key TEXT PK, value JSONB), model_weights(stock TEXT, weights JSONB),
//    stock_data(stock TEXT, rows JSONB), user_settings(user_id UUID, settings JSONB).
// 4. Admin users: full read/write. Viewer users: read-only (db.save blocked by hasAdminRole()).
// 5. Training should run server-side (Edge Function) for large datasets — the current
//    in-browser LogReg/LinReg can stay as a preview mode for <500 rows.
// BACKEND: migrated. localStorage stays as the fast, synchronous read/write
// path (so nothing else in this file has to change), and every save/remove
// also fires a background write to Supabase via localSync.ts — see
// hydrateLocalStorageFromSupabase() in page.tsx for the read side (pulls
// Supabase -> localStorage before this app mounts).
function safeDate(dateStr) {
  if(!dateStr) return null;
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? null : d;
}
function safeDateMs(dateStr) {
  const d = safeDate(dateStr);
  return d ? d.getTime() : null;
}
function safeDateStr(dateStr) {
  const d = safeDate(dateStr);
  return d ? d.toISOString().split('T')[0] : null;
}
function safeYearSpan(rows) {
  if(!rows||rows.length<2) return 0;
  const t0 = safeDateMs(rows[0].date);
  const t1 = safeDateMs(rows[rows.length-1].date);
  if(!t0||!t1) return 0;
  return (t1-t0)/(365.25*86400000);
}
// Validate and clean rows — drop rows with unparseable dates
function sanitiseRows(rows) {
  if(!rows||!Array.isArray(rows)) return [];
  return rows.filter(r=>{
    if(!r||typeof r !== 'object') return false;
    if(!r.date||!safeDateMs(r.date)) return false;
    if(!r.close||isNaN(r.close)||r.close<=0) return false;
    return true;
  });
}

// ─── P1: PROPER CSV TOKENISER ────────────────────────────────────────────────
// Handles quoted fields containing commas: "44,50" → "44,50" not ["44","50"]
function tokeniseCSVLine(line) {
  const tokens = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuote = !inQuote;
    } else if (ch === ',' && !inQuote) {
      tokens.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  tokens.push(cur.trim());
  return tokens;
}

// ─── P4: ROBUST parseNum() WITH K/M/B SUFFIX ────────────────────────────────
// Defined ONCE here — all CSV parsers use this. Handles 1.23M, 234K, 1.2B suffixes
function parseNum(s) {
  if (s === null || s === undefined) return null;
  const str = String(s).replace(/[",\s]/g, '').trim();
  if (!str || str === '-' || str === 'N/A' || str === 'null' || str === 'undefined') return null;
  const lower = str.toLowerCase();
  if (/^-?\d+(\.\d+)?k$/.test(lower)) return parseFloat(lower) * 1_000;
  if (/^-?\d+(\.\d+)?m$/.test(lower)) return parseFloat(lower) * 1_000_000;
  if (/^-?\d+(\.\d+)?b$/.test(lower)) return parseFloat(lower) * 1_000_000_000;
  const n = parseFloat(str);
  return isNaN(n) ? null : n;
}

// ─── P2: EXTENDED DATE PARSER ────────────────────────────────────────────────
// Handles 8 format variants + BOM strip + null-return on unknown (caller skips row)
const MONTH_MAP = {
  jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12,
  january:1,february:2,march:3,april:4,june:6,july:7,august:8,
  september:9,october:10,november:11,december:12,
};
function parseDate(s) {
  if (!s) return null;
  s = String(s).trim().replace(/^\uFEFF/, '').replace(/^["']|["']$/g, '');
  if (!s || s === '-' || s === 'N/A') return null;
  // 1. ISO: 2019-03-15
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // 2. Compact: 20190315
  if (/^\d{8}$/.test(s)) return s.slice(0,4)+'-'+s.slice(4,6)+'-'+s.slice(6,8);
  // 3. Slash ISO: 2019/03/15
  if (/^\d{4}\/\d{2}\/\d{2}$/.test(s)) return s.replace(/\//g,'-');
  // 4. DD/MM/YYYY
  const dmy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (dmy) return dmy[3]+'-'+dmy[2].padStart(2,'0')+'-'+dmy[1].padStart(2,'0');
  // 5. DD-MM-YYYY
  const dmyd = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (dmyd) return dmyd[3]+'-'+dmyd[2].padStart(2,'0')+'-'+dmyd[1].padStart(2,'0');
  // 6. "15 Jan 2019" or "15-Jan-19" or "15/Jan/2019"
  const df = s.match(/^(\d{1,2})[\s\-\/,]+([A-Za-z]{3,9})[\s\-\/,]+(\d{2,4})$/);
  if (df) {
    const mon = MONTH_MAP[df[2].toLowerCase()];
    let yr = parseInt(df[3]);
    if (yr < 100) yr += yr < 50 ? 2000 : 1900;
    if (mon) return yr+'-'+String(mon).padStart(2,'0')+'-'+df[1].padStart(2,'0');
  }
  // 7. "Jan 15, 2019" or "Jan-15-19"
  const mf = s.match(/^([A-Za-z]{3,9})[\s\-\/,]+(\d{1,2})[\s\-\/,]+(\d{2,4})$/);
  if (mf) {
    const mon = MONTH_MAP[mf[1].toLowerCase()];
    let yr = parseInt(mf[3]);
    if (yr < 100) yr += yr < 50 ? 2000 : 1900;
    if (mon) return yr+'-'+String(mon).padStart(2,'0')+'-'+mf[2].padStart(2,'0');
  }
  // 8. Last resort: native Date parse
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
  return null; // caller skips the row
}

// ─── P5: DEDUPLICATE BY DATE ──────────────────────────────────────────────────
function deduplicateByDate(rows) {
  const seen = new Map();
  for (const r of rows) seen.set(r.date, r); // last write wins
  const deduped = Array.from(seen.values()).sort((a,b) => a.date.localeCompare(b.date));
  deduped._dupsRemoved = rows.length - deduped.length;
  return deduped;
}

// ─── P6: OUTLIER PRICE FILTER ────────────────────────────────────────────────
function removeOutlierPrices(rows) {
  if (rows.length < 10) return rows;
  const closes = [...rows].map(r => r.close).sort((a,b) => a-b);
  const median = closes[Math.floor(closes.length / 2)];
  const dropped = [];
  const clean = rows.filter(r => {
    const ok = r.close >= median * 0.1 && r.close <= median * 10;
    if (!ok) dropped.push(r.date);
    return ok;
  });
  clean._outlierDates = dropped;
  return clean;
}

// ─── P7: TRADING GAP MARKERS ─────────────────────────────────────────────────
function markTradingGaps(rows, maxGapDays=10) {
  let gapCount = 0;
  const marked = rows.map((r, i) => {
    if (i === 0) return { ...r, _gapBefore: false };
    const t0 = safeDateMs(rows[i-1].date);
    const t1 = safeDateMs(r.date);
    if(!t0||!t1) return { ...r, _gapBefore: false };
    const daysDiff = (t1 - t0) / 86_400_000;
    if (daysDiff > maxGapDays) { gapCount++; return { ...r, _gapBefore: true }; }
    return { ...r, _gapBefore: false };
  });
  marked._gapCount = gapCount;
  return marked;
}

// ─── P8: STALE TAIL DETECTION ────────────────────────────────────────────────
function detectStaleTail(rows) {
  if (rows.length < 6) return rows;
  const tail = rows.slice(-5);
  const allSameClose = tail.every(r => r.close === tail[0].close);
  const allZeroVol = tail.every(r => (r.volume ?? 0) === 0);
  rows._staleTail = allSameClose && allZeroVol;
  return rows;
}

// ─── P9: WEEKEND ROW FILTER ──────────────────────────────────────────────────
function removeWeekends(rows) {
  const clean = rows.filter(r => {
    const d = safeDate(r.date);
    if(!d) return false; // drop rows with unparseable dates
    const day = d.getDay();
    return day !== 0 && day !== 6;
  });
  clean._weekendsRemoved = rows.length - clean.length;
  return clean;
}

// ─── P10: CORPORATE ACTION DETECTION ─────────────────────────────────────────
// Detects two types of events:
//   >25% drop: rights issue, bonus share, stock split (original logic)
//   8-25% drop: dividend stripping (ex-dividend date price adjustment)
//   Both are marked _corpAction=1 AND _boundary=true so:
//     (a) the drop row is excluded from training input
//     (b) any prediction that would LAND on the drop row is also excluded
// This is why BAT Kenya's -11% drops on 2024-04-15/16/17 were being predicted
// as UP — the model had no visibility that a dividend event was coming.
function detectCorporateActions(rows) {
  const actions = [];
  // First pass: identify corporate action rows
  const corpActionIdx = new Set();
  for (let i = 1; i < rows.length; i++) {
    if (!rows[i-1].close || rows[i-1].close === 0) continue;
    const drop = (rows[i-1].close - rows[i].close) / rows[i-1].close;
    const rise = (rows[i].close - rows[i-1].close) / rows[i-1].close;
    // Dividend stripping: 8%+ single-day drop (not during a gap)
    const isDividend = drop > 0.08 && drop <= 0.25 && !rows[i]._gapBefore;
    // Rights issue / bonus / split: >25% drop
    const isRights = drop > 0.25 && !rows[i]._gapBefore;
    if (isDividend || isRights) {
      corpActionIdx.add(i);
      actions.push({
        date: rows[i].date,
        drop: (drop*100).toFixed(1)+'%',
        type: isRights ? 'rights/split' : 'dividend',
      });
    }
  }
  // Second pass: mark boundaries — the event row + horizon window before it
  // so no training sample can "look through" the corporate action
  const HORIZON_MAX = 90; // days — don't let any prediction land on this row
  const boundaryIdx = new Set();
  for (const ci of corpActionIdx) {
    boundaryIdx.add(ci); // the drop row itself
    // Mark rows before the event so their prediction window won't cross it
    for (let b = Math.max(0, ci - HORIZON_MAX); b < ci; b++) {
      boundaryIdx.add(b);
    }
  }
  for (let i = 0; i < rows.length; i++) {
    const isCA = corpActionIdx.has(i);
    const isBoundary = boundaryIdx.has(i);
    rows[i] = {
      ...rows[i],
      _corpAction: isCA ? 1 : 0,
      _boundary: isBoundary || rows[i]._boundary || false,
    };
  }
  rows._corpActions = actions;
  return rows;
}

// ─── P11: FUZZY TICKER RESOLVER ──────────────────────────────────────────────
function resolveTickerToExpertName(raw) {
  if (!raw) return null;
  const norm = raw.trim().toUpperCase().replace(/[\s\-.]/g, '');
  if (NSE_TICKER_MAP[norm]) return NSE_TICKER_MAP[norm];
  const lnorm = norm.toLowerCase();
  for (const key of Object.keys(EXPERT_BASE)) {
    if (key.toLowerCase().replace(/[\s\-.]/g, '') === lnorm) return key;
  }
  // Fuzzy substring matching REMOVED — caused hallucination.
  // "EQUITY" matched "Equity Bank", "SAF" matched "Safaricom".
  // A single-stock Equity Bank CSV was being split into multiple fake stocks.
  // Rule: only resolve via NSE_TICKER_MAP exact key OR EXPERT_BASE exact name.
  return null;
}

// ─── P12: PER-STOCK DATA QUALITY PIPELINE ────────────────────────────────────
// Order is fixed. Do not reorder these steps.
// Each step depends on the output of the step before it.
function runDataPipeline(rows) {
  let r = removeWeekends(rows);      // P9: strip Sat/Sun carry-forwards
  r = deduplicateByDate(r);          // P5: keep last entry per date
  r = removeOutlierPrices(r);        // P6: drop >10× or <0.1× median
  r = markTradingGaps(r);            // P7: flag suspension gaps (_gapBefore needed by adjustForSplits)
  r = adjustForSplits(r);            // P10a: normalise split-adjusted prices (needs _gapBefore)
  r = detectCorporateActions(r);     // P10b: flag rights issue drops (after split adj so not confused)
  r = detectStaleTail(r);            // P8: flag stale end prices
  r = enforceStockBoundaries(r);     // existing boundary markers
  return r;
}

class AuditLogger {
  constructor(setter) { this.setter = setter; }
  log(event, status, detail = "") {
    const e = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 5)}`, ts: new Date().toISOString(), event, status, detail };
    this.setter(p => [e, ...p].slice(0, 200));
    return e;
  }
}

const EXPERT_BASE = {
  "KCB Group":        { npl: 17.3, divYield: 9.1,  taxFree: false, tag: "Caution",   liq: 2, macroSens: 7, maxAlloc: 15, spread: 0.8,  advisory: "NPL 17.3% above 15% danger zone. Await Q3 recovery.",          macroNote: "Bank NPLs rise with CBK hikes." },
  "Equity Bank":      { npl: 12.2, divYield: 8.5,  taxFree: false, tag: "Buy",        liq: 2, macroSens: 6, maxAlloc: 20, spread: 0.6,  advisory: "NPL 12.2% safe. DRC expansion driving revenue.",               macroNote: "SME lending sensitive to rate hikes." },
  "Safaricom":        { npl: 0,    divYield: 5.8,  taxFree: false, tag: "Hold",       liq: 1, macroSens: 4, maxAlloc: 25, spread: 0.3,  advisory: "M-Pesa dominance. Hold for medium-term appreciation.",         macroNote: "Defensive telecom, less CBK-sensitive." },
  "EABL":             { npl: 0,    divYield: 4.2,  taxFree: false, tag: "Neutral",    liq: 2, macroSens: 3, maxAlloc: 15, spread: 1.1,  advisory: "Flat growth. Resilient consumer staples.",                     macroNote: "Inelastic demand buffers macro impact." },
  "Co-op Bank":       { npl: 14.1, divYield: 7.3,  taxFree: false, tag: "Watch",     liq: 2, macroSens: 7, maxAlloc: 10, spread: 0.9,  advisory: "NPL near danger zone. Monitor Q2 closely.",                    macroNote: "SACCO model amplifies CBK sensitivity." },
  "BAT Kenya":        { npl: 0,    divYield: 11.2, taxFree: false, tag: "Illiquid",  liq: 3, macroSens: 2, maxAlloc: 8,  spread: 3.1,  advisory: "HIGH YIELD but 3.1% spread = instant loss on entry.",          macroNote: "Defensive but dangerously low volume." },
  "Infra Bond (IFB)": { npl: 0,    divYield: 18.2, taxFree: true,  tag: "Top Pick",  liq: 3, macroSens: 8, maxAlloc: 40, spread: 0,    advisory: "Tax-free 18.2% — highest risk-adjusted return in Kenya.",      macroNote: "CBK cut = prices rise." },
  "T-Bill 91-day":    { npl: 0,    divYield: 15.8, taxFree: false, tag: "Safe",      liq: 1, macroSens: 9, maxAlloc: 30, spread: 0,    advisory: "Liquid, government-guaranteed. Best short-term cash parking.", macroNote: "Tracks CBK base rate directly." },
  "T-Bill 364-day":   { npl: 0,    divYield: 16.4, taxFree: false, tag: "Safe",      liq: 2, macroSens: 9, maxAlloc: 30, spread: 0,    advisory: "16.4% yield, best 1-year risk-free instrument.",               macroNote: "Rate hike post-purchase locks in lower yield." },
  "Bitcoin":          { npl: 0,    divYield: 0,    taxFree: false, tag: "High Risk",  liq: 1, macroSens: 5, maxAlloc: 10, spread: 0.05, advisory: "Post-halving cycle. DCA only. Max 10% of portfolio.",           macroNote: "Dollar strength hurts BTC." },
  "Ethereum":         { npl: 0,    divYield: 4.5,  taxFree: false, tag: "High Risk",  liq: 1, macroSens: 5, maxAlloc: 8,  spread: 0.05, advisory: "Staking yield adds income. Strong long-term fundamentals.",     macroNote: "Correlates with BTC cycles." },
  "NVIDIA":           { npl: 0,    divYield: 0.03, taxFree: false, tag: "Growth",     liq: 1, macroSens: 6, maxAlloc: 15, spread: 0.02, advisory: "AI chip leader. Stretched valuation, intact growth story.",     macroNote: "Fed hikes compress growth multiples." },
  "Apple":            { npl: 0,    divYield: 0.5,  taxFree: false, tag: "Safe",       liq: 1, macroSens: 4, maxAlloc: 20, spread: 0.01, advisory: "Most liquid stock on earth. Core long-term hold.",              macroNote: "Strong cash. Services revenue sticky." },
  "Acorn REIT":       { npl: 0,    divYield: 8.9,  taxFree: false, tag: "Illiquid",  liq: 3, macroSens: 6, maxAlloc: 15, spread: 2.8,  advisory: "Good yield but 2.8% spread and thin volume = trap.",           macroNote: "CBK hikes raise developer costs." },
  "Stanbic Bank":     { npl: 9.8,  divYield: 6.2,  taxFree: false, tag: "Buy",       liq: 2, macroSens: 6, maxAlloc: 15, spread: 0.9,  advisory: "Solid NPL. Regional diversification adds resilience.",          macroNote: "CBK hikes compress net interest margin." },
  "Absa Kenya":       { npl: 11.2, divYield: 7.1,  taxFree: false, tag: "Watch",     liq: 2, macroSens: 6, maxAlloc: 12, spread: 1.1,  advisory: "NPL elevated but improving. Monitor provisions.",               macroNote: "Sensitive to SME credit quality." },
  "NCBA Group":       { npl: 10.4, divYield: 5.8,  taxFree: false, tag: "Neutral",   liq: 2, macroSens: 6, maxAlloc: 12, spread: 1.2,  advisory: "Loop mobile banking growing. Mid-tier risks apply.",            macroNote: "Digital lending NPLs rising industry-wide." },
  "Bamburi Cement":   { npl: 0,    divYield: 8.4,  taxFree: false, tag: "Watch",     liq: 2, macroSens: 5, maxAlloc: 10, spread: 1.8,  advisory: "Infrastructure spend supports demand. Input cost risk.",         macroNote: "Energy costs rise with weak KES." },
  "Jubilee Holdings": { npl: 0,    divYield: 4.8,  taxFree: false, tag: "Buy",       liq: 2, macroSens: 4, maxAlloc: 12, spread: 1.3,  advisory: "Insurance penetration growing. Solid regional footprint.",      macroNote: "Claims inflation rises with CPI." },
  "Britam Holdings":  { npl: 0,    divYield: 2.1,  taxFree: false, tag: "Watch",     liq: 2, macroSens: 5, maxAlloc: 8,  spread: 1.6,  advisory: "Restructuring ongoing. Recovery play.",                         macroNote: "Investment portfolio sensitive to rate changes." },
  "Kenya Power":      { npl: 0,    divYield: 0,    taxFree: false, tag: "Caution",   liq: 2, macroSens: 7, maxAlloc: 5,  spread: 1.4,  advisory: "Regulatory risk high. Avoid until tariff clarity.",              macroNote: "Debt-heavy balance sheet vulnerable to hikes." },
  "I&M Group":        { npl: 8.9,  divYield: 8.3,  taxFree: false, tag: "Buy",       liq: 2, macroSens: 6, maxAlloc: 15, spread: 1.0,  advisory: "Best NPL ratio among mid-tier banks. Undervalued.",             macroNote: "Regional expansion adds FX risk." },
  "Total Energies":   { npl: 0,    divYield: 5.6,  taxFree: false, tag: "Buy",       liq: 2, macroSens: 4, maxAlloc: 12, spread: 1.0,  advisory: "Consistent margins. Fuel retail resilient to macro.",           macroNote: "Oil price swings affect inventory margins." },
  "Kakuzi":           { npl: 0,    divYield: 7.3,  taxFree: false, tag: "Buy",       liq: 3, macroSens: 3, maxAlloc: 8,  spread: 2.1,  advisory: "Avocado exports booming. Low NSE correlation.",                 macroNote: "USD earner — benefits from weak KES." },
  "Kengen":           { npl: 0,    divYield: 3.1,  taxFree: false, tag: "Neutral",   liq: 2, macroSens: 5, maxAlloc: 10, spread: 1.5,  advisory: "Geothermal capacity expansion positive long term.",             macroNote: "USD-denominated debt hurts on weak KES." },
  "Nation Media":     { npl: 0,    divYield: 3.2,  taxFree: false, tag: "Neutral",   liq: 3, macroSens: 3, maxAlloc: 8,  spread: 2.4,  advisory: "Digital transition ongoing. Print revenue declining.",          macroNote: "Ad spend falls in tight macro environment." },
};

// P11: NSE_TICKER_MAP — full alias map with historical name variants
// Placed immediately after EXPERT_BASE so resolveTickerToExpertName() can reference both
const NSE_TICKER_MAP = {
  // ── Banking & Finance ────────────────────────────────────────────────────
  "KCB":"KCB Group",        "KCBGROUP":"KCB Group",
  "EQTY":"Equity Bank",     "EQUITY":"Equity Bank",     "EQUITYBANK":"Equity Bank",
  "COOP":"Co-op Bank",      "COOPERATIVE":"Co-op Bank", "COOBANK":"Co-op Bank",
  "ABSA":"Absa Kenya",      "ABSAKENYA":"Absa Kenya",   "BARCLAYS":"Absa Kenya",    "BBK":"Absa Kenya",
  "NCBA":"NCBA Group",      "CBA":"NCBA Group",         "NCBAGROUP":"NCBA Group",
  "IMH":"I&M Group",        "IM":"I&M Group",           "IMHGROUP":"I&M Group",
  "SBIC":"Stanbic Bank",    "STANBIC":"Stanbic Bank",   "CFC":"Stanbic Bank",
  "DTK":"Diamond Trust Bank","DTB":"Diamond Trust Bank","DTBANK":"Diamond Trust Bank",
  "HF":"HF Group",          "HFCK":"HF Group",          "HFGROUP":"HF Group",
  "NBK":"National Bank",    "NATIONALBANK":"National Bank",
  "SBK":"Standard Chartered","SCBK":"Standard Chartered","STANDARDCHARTERED":"Standard Chartered",
  "CFCB":"CFC Bank",
  "GBKL":"Gulf African Bank",
  "PRIME":"Prime Bank",
  "KWFT":"Kenya Women Microfinance","KWFTB":"Kenya Women Microfinance",

  // ── Telecoms ─────────────────────────────────────────────────────────────
  "SCOM":"Safaricom",       "SAFARICOM":"Safaricom",

  // ── Insurance ────────────────────────────────────────────────────────────
  "JUB":"Jubilee Holdings", "JUBILEE":"Jubilee Holdings","JUBH":"Jubilee Holdings",
  "BRIT":"Britam Holdings", "BRITAM":"Britam Holdings",
  "CIC":"CIC Insurance",    "CICG":"CIC Insurance",
  "PAFR":"Pan Africa Insurance","PAFRINS":"Pan Africa Insurance",
  "LKL":"Liberty Kenya",    "LIBERTY":"Liberty Kenya",
  "UAP":"UAP Holdings",
  "KNRE":"Kenya Re",        "KENYARE":"Kenya Re",        "KENYAREINSURANCE":"Kenya Re",

  // ── ETFs ─────────────────────────────────────────────────────────────────
  "GLD":"ABSA NewGold ETF",  "NEWGOLD":"ABSA NewGold ETF","ABSANEWGOLD":"ABSA NewGold ETF",

  // ── Paints & Allied ──────────────────────────────────────────────────────
  "BERG":"Crown Paints",     "CRWN":"Crown Paints",       "CROWNBERGER":"Crown Paints","CROWNPAINTS":"Crown Paints",

  // ── Manufacturing & Consumer ──────────────────────────────────────────────
  "EABL":"EABL",
  "BAT":"BAT Kenya",        "BATK":"BAT Kenya",
  "BAMB":"Bamburi Cement",  "BAMBURI":"Bamburi Cement",
  "ARM":"ARM Cement",       "ARMCM":"ARM Cement",
  "CARB":"Carbacid",        "CARBACID":"Carbacid",
  "UNGA":"Unga Group",
  "EVRD":"Eveready",        "EVEREADY":"Eveready",
  "KWAL":"Kenya Wine Agencies","KWAG":"Kenya Wine Agencies",
  "GCML":"Grain Bulk Handlers",
  "ICDC":"ICDC",
  "BOC":"BOC Kenya",
  "DNML":"Deacons",

  // ── Energy ───────────────────────────────────────────────────────────────
  "KEGN":"Kengen",          "KENGEN":"Kengen",
  "KPLC":"Kenya Power",     "KENYAPOWER":"Kenya Power",
  "TOTL":"Total Energies",  "TOTAL":"Total Energies",   "TOTALENERGIES":"Total Energies",
  "KPET":"KenolKobil",      "KK":"KenolKobil",          "KENOL":"KenolKobil",
  "UMKL":"Umeme Kenya",
  "GPLD":"Genghis Capital",

  // ── Agriculture ──────────────────────────────────────────────────────────
  "KAKZ":"Kakuzi",
  "KAPC":"Kapchorua Tea",   "KAPCHORUA":"Kapchorua Tea",
  "LIMR":"Limuru Tea",      "LIMURU":"Limuru Tea",
  "TEAA":"Tea Brokers",
  "ORCH":"Williamson Tea",  "WLTD":"Williamson Tea",
  "SASN":"Sasini",          "SASINI":"Sasini",
  "EGAD":"EA Growers",

  // ── Real Estate & Investment ──────────────────────────────────────────────
  "UCHM":"Acorn REIT",      "ACORN":"Acorn REIT",
  "HRMN":"Home Afrika",     "HOMEAFRIKA":"Home Afrika",
  "KURV":"Kurwitu Ventures",
  "CTUM":"Centum",          "CENTUM":"Centum",

  // ── Media & Technology ───────────────────────────────────────────────────
  "NMG":"Nation Media",     "NATION":"Nation Media",    "NMGR":"Nation Media",
  "SKL":"Scangroup",        "SCAN":"Scangroup",         "SCANGROUP":"Scangroup",
  "TPS":"TPS Serena",       "SERENA":"TPS Serena",

  // ── Transport ────────────────────────────────────────────────────────────
  "KQ":"Kenya Airways",     "KENYAAIRWAYS":"Kenya Airways","KQAIR":"Kenya Airways",
  "LPKR":"Longhorn Publishers",
  "NSE":"NSE Ltd",          "NSEL":"NSE Ltd",
};

// ─── HISTORICAL CBK RATES ────────────────────────────────────────────────────
const CBK_HISTORY = [
  {from:"2019-01-01",to:"2020-03-01",rate:9.0},
  {from:"2020-03-01",to:"2020-04-01",rate:8.25},
  {from:"2020-04-01",to:"2022-05-01",rate:7.0},
  {from:"2022-05-01",to:"2022-09-01",rate:7.5},
  {from:"2022-09-01",to:"2023-02-01",rate:8.25},
  {from:"2023-02-01",to:"2023-06-01",rate:9.5},
  {from:"2023-06-01",to:"2023-12-01",rate:10.5},
  {from:"2023-12-01",to:"2024-02-01",rate:12.5},
  {from:"2024-02-01",to:"2024-08-01",rate:13.0},
  {from:"2024-08-01",to:"2025-04-01",rate:12.0},
  {from:"2025-04-01",to:"2099-01-01",rate:10.75},
];
function getCbkRateOnDate(dateStr) {
  const d = dateStr.slice(0,10);
  const e = CBK_HISTORY.find(e=>d>=e.from&&d<e.to);
  return e ? e.rate : 13.0;
}

// ─── NSE EARNINGS CALENDAR ───────────────────────────────────────────────────
const NSE_EARNINGS = [
  {stock:"Equity Bank",date:"2024-03-14"},{stock:"Equity Bank",date:"2024-08-29"},
  {stock:"KCB Group",date:"2024-03-21"},{stock:"KCB Group",date:"2024-09-26"},
  {stock:"Safaricom",date:"2024-05-10"},{stock:"Safaricom",date:"2024-11-08"},
  {stock:"EABL",date:"2024-02-28"},{stock:"EABL",date:"2024-09-12"},
  {stock:"Co-op Bank",date:"2024-03-28"},{stock:"Co-op Bank",date:"2024-08-22"},
  {stock:"BAT Kenya",date:"2024-03-07"},{stock:"Acorn REIT",date:"2024-04-18"},
  {stock:"Stanbic Bank",date:"2024-03-15"},{stock:"I&M Group",date:"2024-03-20"},
  {stock:"NCBA Group",date:"2024-03-25"},{stock:"Absa Kenya",date:"2024-03-22"},
];

// ─── DIVIDEND HISTORY ────────────────────────────────────────────────────────
const DIVIDEND_HISTORY = {
  "Safaricom":  [{exDate:"2024-09-20",amount:0.76},{exDate:"2023-09-22",amount:0.64}],
  "Equity Bank":[{exDate:"2024-10-04",amount:4.00},{exDate:"2023-10-06",amount:3.00}],
  "KCB Group":  [{exDate:"2024-09-27",amount:2.00},{exDate:"2023-09-29",amount:1.00}],
  "EABL":       [{exDate:"2024-11-15",amount:3.75},{exDate:"2023-11-10",amount:2.50}],
  "Co-op Bank": [{exDate:"2024-10-11",amount:1.50},{exDate:"2023-10-13",amount:1.00}],
  "BAT Kenya":  [{exDate:"2024-08-30",amount:22.0},{exDate:"2023-09-01",amount:20.0}],
  "Stanbic Bank":[{exDate:"2024-09-15",amount:3.50}],
  "I&M Group":  [{exDate:"2024-10-01",amount:2.80}],
};
const BANK_STOCKS=["KCB Group","Equity Bank","Co-op Bank","Stanbic Bank","NCBA Group","Absa Kenya","I&M Group"];

function checkDividendCapture(stockName) {
  const divs=DIVIDEND_HISTORY[stockName]; if(!divs||!divs.length) return null;
  const today=new Date();
  const upcoming=divs.map(d=>{
    const exMs = safeDateMs(d.exDate);
    return {...d, msToEx: exMs ? exMs - today.getTime() : -1};
  }).filter(d=>d.msToEx>0).sort((a,b)=>a.msToEx-b.msToEx);
  if(!upcoming.length) return null;
  const next=upcoming[0];
  const daysToExDate=Math.round(next.msToEx/86400000);
  if(daysToExDate>45) return null;
  return {daysToExDate,amount:next.amount,exDate:next.exDate,historicalAvgRise:BANK_STOCKS.includes(stockName)?6.2:4.1};
}

// ─── CSV PARSER — handles NSE export format + Investing.com/Yahoo Finance ────
// P1: tokeniseCSVLine for all line splits  P2: extended parseDate()
// P3: BOM strip  P4: top-level parseNum()  P12: pipeline applied after parse
function parseCSV(text) {
  const rawLines = text.trim().split(/\r?\n/).filter(l => l.trim());
  if (rawLines.length < 2) throw new Error("CSV must have a header row and at least one data row");
  // P3: BOM strip
  rawLines[0] = rawLines[0].replace(/^\uFEFF/, '');
  const header = tokeniseCSVLine(rawLines[0]).map(h => h.toLowerCase());

  // ── NSE website export format detection ─────────────────────────────────
  const isNSEFormat = header.includes("code") && header.some(h => h.includes("day price") || h.includes("day high"));
  const colIdx = (names) => { for (const n of names) { const i = header.findIndex(h => h.includes(n)); if (i >= 0) return i; } return -1; };

  if (isNSEFormat) {
    const dateCol  = colIdx(["date"]);
    const codeCol  = colIdx(["code"]);
    const highCol  = colIdx(["day high"]);
    const lowCol   = colIdx(["day low"]);
    const closeCol = colIdx(["day price"]);
    const volCol   = colIdx(["volume"]);
    if (dateCol < 0 || closeCol < 0) throw new Error("NSE format detected but Date or Day Price column missing");
    let detectedStockName = null;
    const firstCols = tokeniseCSVLine(rawLines[1]);
    if (codeCol >= 0 && firstCols[codeCol]) detectedStockName = firstCols[codeCol].trim().toUpperCase();
    let skippedDates = 0;
    const rows = [];
    for (let i = 1; i < rawLines.length; i++) {
      const cols = tokeniseCSVLine(rawLines[i]);
      const date = parseDate(cols[dateCol]);
      if (!date) { skippedDates++; continue; }
      const close = parseNum(cols[closeCol]);
      if (!close || close <= 0) continue;
      rows.push({ date, open: close, high: parseNum(cols[highCol]) ?? close, low: parseNum(cols[lowCol]) ?? close, close, volume: parseNum(cols[volCol]) ?? 0 });
    }
    if (rows.length < 10) throw new Error(`Only ${rows.length} valid rows parsed from NSE format`);
    const clean = runDataPipeline(rows);
    const warnings = [];
    if (skippedDates > 0 && skippedDates / rawLines.length > 0.05) warnings.push(`⚠ ${skippedDates} rows skipped — unrecognised date format.`);
    if (clean._dupsRemoved > 0) warnings.push(`ℹ ${clean._dupsRemoved} duplicate dates removed — kept latest value per date.`);
    if (clean._outlierDates?.length > 0) warnings.push(`⚠ ${clean._outlierDates.length} likely price errors removed (>10× or <0.1× median). First: ${clean._outlierDates.slice(0,3).join(', ')}`);
    if (clean._weekendsRemoved > 0) warnings.push(`ℹ ${clean._weekendsRemoved} weekend rows removed.`);
    if (clean._corpActions?.length > 0) {
      const dividends = clean._corpActions.filter(a=>a.type==='dividend');
      const rights    = clean._corpActions.filter(a=>a.type==='rights/split');
      if(dividends.length > 0) warnings.push(`📅 ${dividends.length} ex-dividend date(s) detected (${dividends.map(a=>a.date).slice(0,3).join(', ')}). Rows within 90 days before each event are marked as training boundaries — predictions cannot cross these dates.`);
      if(rights.length > 0)    warnings.push(`⚠️ ${rights.length} rights issue / bonus share / split event(s) detected: ${rights.map(a=>a.date).slice(0,3).join(', ')}.`);
    }
    if (clean._staleTail) warnings.push(`⚠ Last rows appear to be stale/repeated prices. Your prediction may be based on outdated data.`);
    clean._warnings = warnings;
    clean._detectedStockName = detectedStockName;
    return clean;
  }

  // ── Standard format ───────────────────────────────────────────────────────
  const dateCol  = colIdx(["date"]);
  const closeCol = colIdx(["price", "close", "last", "adj close", "closing"]);
  const openCol  = colIdx(["open"]);
  const highCol  = colIdx(["high", "max"]);
  const lowCol   = colIdx(["low", "min"]);
  const volCol   = colIdx(["vol", "volume"]);
  if (dateCol < 0) throw new Error("No 'Date' column found");
  if (closeCol < 0) throw new Error("No price/close column found");
  let skippedDates = 0;
  const rows = [];
  for (let i = 1; i < rawLines.length; i++) {
    const cols = tokeniseCSVLine(rawLines[i]);
    const date = parseDate(cols[dateCol]);
    if (!date) { skippedDates++; continue; }
    const close = parseNum(cols[closeCol]);
    if (!close || close <= 0) continue;
    rows.push({ date, open: parseNum(cols[openCol]) ?? close, high: parseNum(cols[highCol]) ?? close, low: parseNum(cols[lowCol]) ?? close, close, volume: parseNum(cols[volCol]) ?? 0 });
  }
  if (rows.length < 10) throw new Error(`Only ${rows.length} valid rows parsed — check CSV format`);
  const clean = runDataPipeline(rows);
  const warnings = [];
  if (skippedDates > 0 && skippedDates / rawLines.length > 0.05) warnings.push(`⚠ ${skippedDates} rows skipped — unrecognised date format.`);
  if (clean._dupsRemoved > 0) warnings.push(`ℹ ${clean._dupsRemoved} duplicate dates removed.`);
  if (clean._outlierDates?.length > 0) warnings.push(`⚠ ${clean._outlierDates.length} likely price errors removed. First: ${clean._outlierDates.slice(0,3).join(', ')}`);
  if (clean._weekendsRemoved > 0) warnings.push(`ℹ ${clean._weekendsRemoved} weekend rows removed.`);
  if (clean._corpActions?.length > 0) warnings.push(`ℹ ${clean._corpActions.length} possible corp actions flagged: ${clean._corpActions.map(a=>a.date).slice(0,3).join(', ')}.`);
  if (clean._staleTail) warnings.push(`⚠ Last rows appear stale/repeated. Prediction may be based on outdated data.`);
  clean._warnings = warnings;
  return clean;
}


// ─── BULK CSV ENGINE (Part 3) ─────────────────────────────────────────────────
// P11: NSE_TICKER_MAP is defined above near hasAdminRole (after EXPERT_BASE)
// Keeping ALL_KNOWN_IDENTIFIERS and matchStockName here for bulk detection

const ALL_KNOWN_IDENTIFIERS = [
  ...Object.keys(NSE_TICKER_MAP),
  ...Object.keys(NSE_TICKER_MAP).map(k=>NSE_TICKER_MAP[k].toLowerCase()),
  ...Object.keys(EXPERT_BASE).map(k=>k.toLowerCase()),
];

// matchStockName delegates to resolveTickerToExpertName (P11 fuzzy resolver)
function matchStockName(raw) {
  return resolveTickerToExpertName(raw);
}

// ─── FIX 5: Pre-split raw text cleaner ───────────────────────────────────────
// Runs BEFORE parseBulkCSV so the split logic sees clean data.
// Handles: multiple header rows, empty rows, BOM, repeated header lines.
function precleanBulkText(text) {
  const lines = text
    .replace(/^\uFEFF/, '')               // strip BOM
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0);          // drop empty lines

  if (lines.length < 2) return text;

  // Score a line by how many of its tokens are non-numeric/non-date (header-like)
  const scoreNonNumeric = (line) => {
    const toks = tokeniseCSVLine(line);
    return toks.filter(t => isNaN(parseFloat(t.replace(/[,"%]/g,''))) && !parseDate(t)).length;
  };

  // Find the best candidate header in the first 10 lines
  let headerIdx = 0;
  let bestScore = -1;
  for (let i = 0; i < Math.min(10, lines.length); i++) {
    const s = scoreNonNumeric(lines[i]);
    if (s > bestScore) { bestScore = s; headerIdx = i; }
  }

  const headerLine = lines[headerIdx];
  const headerLower = headerLine.toLowerCase();

  // Keep exactly one header row + all valid data rows after it
  const dataLines = lines
    .slice(headerIdx + 1)
    .filter(l => {
      // Drop repeated header rows that match the header line
      if (l.toLowerCase() === headerLower) return false;
      const toks = tokeniseCSVLine(l);
      if (toks.length < 2) return false;
      // Keep lines where at least 40% of tokens are numeric/date (i.e. actual data)
      const numericCount = toks.filter(t =>
        parseDate(t) || !isNaN(parseFloat(t.replace(/[,"%$]/g,'')))
      ).length;
      return numericCount >= Math.ceil(toks.length * 0.4);
    });

  return [headerLine, ...dataLines].join('\n');
}

// ─── FIX 2: Combined/aggregate filename blacklist ─────────────────────────────
// Returns true if a filename or stock name looks like it describes a combined
// dataset rather than a single stock.
const COMBINED_FILE_PATTERNS = [
  /all[\s_-]?stocks?/i,
  /combined/i,
  /full[\s_-]?market/i,
  /nse[\s_-]?data/i,
  /bulk[\s_-]?data/i,
  /multi[\s_-]?stock/i,
  /market[\s_-]?data/i,
  /historical[\s_-]?data[\s_-]?\d{4}/i,
  /\b\d{4}[-_]\d{4}\b/,             // year range like "2007-2024" (hyphen/underscore only)
  /all[\s_-]?securities/i,
  /nse[\s_-]?all/i,
];

function isCombinedFilename(name) {
  if (!name) return false;
  return COMBINED_FILE_PATTERNS.some(p => p.test(name));
}

function parseBulkCSV(text) {
  try {
    // FIX 5: Pre-clean raw text before any parsing
    const cleanedText = precleanBulkText(text);

    const rawLines = cleanedText.trim().split(/\r?\n/).filter(l=>l.trim());
    if(rawLines.length < 3) return {isBulk:false, passUsed:"none"};
    // P3: BOM already stripped by precleanBulkText
    // P1: tokeniseCSVLine for header
    const header = tokeniseCSVLine(rawLines[0]).map(h=>h.toLowerCase().trim());

    // Wide format: 3+ headers contain underscore-separated ticker patterns
    const wideMatches = header.filter(h=>h.includes("_")&&ALL_KNOWN_IDENTIFIERS.some(id=>h.startsWith(id.toLowerCase()+"_")||h.includes("_"+id.toLowerCase())));
    if(wideMatches.length >= 3) {
      const dateCol = header.findIndex(h=>h.includes("date"));
      if(dateCol<0) return {isBulk:false, passUsed:"none"};
      const tickers = new Set();
      for(const h of header) {
        const parts = h.split("_");
        if(parts.length>=2) {
          const possible = parts.slice(0,-1).join("_").toUpperCase();
          if(matchStockName(possible)||NSE_TICKER_MAP[possible]) tickers.add(possible);
        }
      }
      if(tickers.size < 2) return {isBulk:false, passUsed:"none"};
      // P1: tokeniseCSVLine for all data rows
      const rawRows = rawLines.slice(1).map(l=>tokeniseCSVLine(l));
      const stockRows = {};
      for(const ticker of tickers) {
        const cl = header.findIndex(h=>h===ticker.toLowerCase()+"_close"||h===ticker.toLowerCase()+"_price");
        const hi = header.findIndex(h=>h===ticker.toLowerCase()+"_high");
        const lo = header.findIndex(h=>h===ticker.toLowerCase()+"_low");
        const vo = header.findIndex(h=>h===ticker.toLowerCase()+"_vol"||h===ticker.toLowerCase()+"_volume");
        if(cl<0) continue;
        stockRows[ticker] = rawRows.map(cols=>{
          // P4: top-level parseNum  P2: top-level parseDate
          const close=parseNum(cols[cl]); const date=parseDate(cols[dateCol]);
          if(!close||close<=0||!date) return null;
          return {date,open:close,high:parseNum(cols[hi])??close,low:parseNum(cols[lo])??close,close,volume:parseNum(cols[vo])??0};
        }).filter(Boolean);
      }
      const totalRows = Object.values(stockRows).reduce((s,r)=>s+r.length,0);
      const detectedStocks = [...tickers].map(t=>matchStockName(t)||t);
      return {isBulk:true,format:"wide",detectedStocks,stockRows,totalRows};
    }

    // FIX 1: Long format — scan ALL data rows (not just first 20) to find ticker column.
    // The old code sampled only 20 rows; chronologically-sorted CSVs where the first
    // 20 rows all belong to one stock were silently returned as isBulk:false.
    const allDataRows = rawLines.slice(1).map(l=>tokeniseCSVLine(l));

    // Pass A: check header names that are definitively ticker columns
    // Uses exact match first, then partial match (e.g. "company code" contains "code")
    const KNOWN_TICKER_HEADERS = ["code","ticker","symbol","scrip","stock","security code","company code"];
    let tickerCol = -1;
    let passUsed = "none"; // track which pass detected the bulk structure
    for(const tname of KNOWN_TICKER_HEADERS){
      const idx = header.findIndex(h=>{
        const ht=h.trim();
        return ht===tname || ht===tname+"s" || ht.includes(tname);
      });
      if(idx>=0){
        const seen=new Set();
        for(const row of allDataRows){ const v=row[idx]?.trim().toUpperCase(); if(v&&v.length>=2) seen.add(v); }
        if(seen.size>=2){ tickerCol=idx; passUsed="A"; break; }
      }
    }

    // Pass B: find column with 2+ DISTINCT known tickers, each in 5+ rows
    // STRICT: matchStockName must return a known stock (exact map lookup only)
    // Single occurrence of a ticker name (e.g. in a "Notes" column) is rejected.
    if(tickerCol<0){
      for(let ci=0; ci<header.length; ci++){
        const tickerCounts = new Map();
        for(const row of allDataRows){
          const val = row[ci]?.trim().toUpperCase();
          const resolved = val ? matchStockName(val) : null;
          if(resolved) tickerCounts.set(resolved, (tickerCounts.get(resolved)||0)+1);
        }
        // Require: at least 2 distinct known tickers, each appearing 5+ times
        const qualifying = [...tickerCounts.entries()].filter(([,n])=>n>=5);
        if(qualifying.length >= 2){ tickerCol=ci; passUsed="B"; break; }
      }
    }

    // Pass C: REMOVED — was causing false positives on single-stock CSVs.
    // Columns like "HIGH", "LOW", "VOL", "JAN", "FEB" all match /^[A-Z]{2,7}$/
    // causing Equity Bank CSVs to be split into Safaricom, BAT Kenya etc.
    // RULE: If Pass A (known header) and Pass B (known tickers) both fail,
    // treat the file as single-stock. Never guess a ticker column.

    if(tickerCol<0) return {isBulk:false};

    const detectedSet = new Set(allDataRows.map(r=>r[tickerCol]?.trim().toUpperCase()).filter(Boolean));
    const detectedStocks = [...detectedSet].map(t=>matchStockName(t)||t);
    if(detectedStocks.length < 2) return {isBulk:false};

    const dateRange = {first:null,last:null};
    for(const r of allDataRows){
      const d = parseDate(r[0]);
      if(d){ if(!dateRange.first||d<dateRange.first) dateRange.first=d; if(!dateRange.last||d>dateRange.last) dateRange.last=d; }
    }
    return {isBulk:true, passUsed, format:"long",detectedStocks,tickerCol,rawRows:allDataRows,headerRow:header,totalRows:allDataRows.length,dateRange};
  } catch(e) {
    console.warn("parseBulkCSV error:",e);
    return {isBulk:false};
  }
}

function splitBulkByStock(bulkResult) {
  const out = new Map();

  // P12: pipeline helper for each stock group
  const applyPipeline = (rows, ticker) => {
    // ─── Per-stock data quality pipeline ───────────────────────
    // Order is fixed. Do not reorder these steps.
    // Each step depends on the output of the step before it.
    // ────────────────────────────────────────────────────────────
    const clean = runDataPipeline(rows.filter(r=>r.close>0).sort((a,b)=>a.date.localeCompare(b.date)));
    const name = matchStockName(ticker)||ticker;
    const thin = clean.length < 30;
    return {rows:clean, mapped:name, ticker, thin, unrecognised:!matchStockName(ticker),
      staleTail:clean._staleTail, gapCount:clean._gapCount||0,
      corpActions:clean._corpActions||[], outlierDates:clean._outlierDates||[]};
  };

  if(bulkResult.format==="wide") {
    for(const [ticker, rows] of Object.entries(bulkResult.stockRows||{})) {
      const result = applyPipeline(rows, ticker);
      out.set(result.mapped, result);
    }
    return out;
  }

  // Long format — P11: merge groups that resolve to same EXPERT_BASE name
  const {rawRows, headerRow, tickerCol} = bulkResult;
  if(!rawRows||tickerCol==null) return out;

  // Robust column finder: tries multiple name variants, returns first match
  // Uses both exact and partial (includes) matching on lowercase trimmed header tokens
  const findCol = (...names) => {
    for(const n of names){
      const i = headerRow.findIndex(h=>h.trim()===n||h.trim().includes(n));
      if(i>=0) return i;
    }
    return -1;
  };

  const dateCol  = findCol("date","trade date","time");
  const closeCol = findCol("day price","day's price","closing price","last price","adj close","close","price","last","closing");
  const highCol  = findCol("day high","day's high","high price","high","max");
  const lowCol   = findCol("day low","day's low","low price","low","min");
  const volCol   = findCol("total volume","traded volume","volume","vol","shares");
  const openCol  = findCol("open price","opening","open");

  if(dateCol<0){
    console.warn("[splitBulkByStock] No date column found in header:",headerRow);
    return out;
  }
  if(closeCol<0){
    console.warn("[splitBulkByStock] No close/price column found in header:",headerRow);
    return out;
  }

  // P11: Group rows by raw ticker, then merge groups resolving to same expert name
  const groupedByTicker = new Map();
  for(const cols of rawRows){
    const ticker=(cols[tickerCol]||"").trim().toUpperCase();
    if(!ticker) continue;
    // P4: top-level parseNum  P2: top-level parseDate
    const close=parseNum(cols[closeCol]); const date=parseDate(cols[dateCol]);
    if(!close||close<=0||!date) continue;
    if(!groupedByTicker.has(ticker)) groupedByTicker.set(ticker,[]);
    groupedByTicker.get(ticker).push({date,
        open:parseNum(cols[openCol])??close,
        high:parseNum(cols[highCol])??close,
        low:parseNum(cols[lowCol])??close,
        close,
        volume:parseNum(cols[volCol])??0});
  }

  // P11: Merge tickers that resolve to the same EXPERT_BASE name
  const mergedGroups = new Map();
  for(const [rawTicker, tickerRows] of groupedByTicker) {
    const resolved = resolveTickerToExpertName(rawTicker) ?? rawTicker;
    const existing = mergedGroups.get(resolved) ?? [];
    mergedGroups.set(resolved, [...existing, ...tickerRows]);
  }

  for(const [resolvedName, rows] of mergedGroups) {
    const result = applyPipeline(rows, resolvedName);
    out.set(resolvedName, result);
  }
  return out;
}


// ─── TECHNICAL INDICATORS ────────────────────────────────────────────────────
const TA = {
  sma(arr, n) { return arr.map((_, i) => i < n-1 ? null : arr.slice(i-n+1, i+1).reduce((a,b)=>a+b,0)/n); },
  ema(arr, n) {
    const k = 2/(n+1); const out = new Array(arr.length).fill(null); let e = null;
    for (let i=0; i<arr.length; i++) {
      if (e===null) { if (i>=n-1) e=arr.slice(0,n).reduce((a,b)=>a+b,0)/n; }
      else e = arr[i]*k + e*(1-k);
      if (e!==null) out[i]=e;
    }
    return out;
  },
  rsi(arr, n=14) {
    const out = new Array(arr.length).fill(null); if (arr.length < n+1) return out;
    let gA=0, lA=0;
    for (let i=1; i<=n; i++) { const d=arr[i]-arr[i-1]; if(d>0) gA+=d; else lA-=d; }
    gA/=n; lA/=n;
    out[n] = lA===0 ? 100 : 100 - 100/(1+gA/lA);
    for (let i=n+1; i<arr.length; i++) {
      const d=arr[i]-arr[i-1];
      gA=(gA*(n-1)+Math.max(0,d))/n; lA=(lA*(n-1)+Math.max(0,-d))/n;
      out[i] = lA===0 ? 100 : 100-100/(1+gA/lA);
    }
    return out;
  },
  macd(arr) {
    const e12=TA.ema(arr,12), e26=TA.ema(arr,26);
    const ml=arr.map((_,i)=>e12[i]&&e26[i]?e12[i]-e26[i]:null);
    const valid=ml.filter(v=>v!==null);
    const sf=TA.ema(valid,9);
    const sig=new Array(arr.length).fill(null); let vi=0;
    for (let i=0; i<arr.length; i++) { if(ml[i]!==null) sig[i]=sf[vi++]??null; }
    return { macdLine:ml, signal:sig, histogram:arr.map((_,i)=>ml[i]!==null&&sig[i]!==null?ml[i]-sig[i]:null) };
  },
  bb(arr, n=20, k=2) {
    const mid=TA.sma(arr,n);
    return arr.map((_,i)=>{
      if(mid[i]===null) return {upper:null,mid:null,lower:null,pct:null,width:null};
      const sl=arr.slice(i-n+1,i+1), m=mid[i];
      const std=Math.sqrt(sl.reduce((s,v)=>s+(v-m)**2,0)/n);
      const up=m+k*std, lo=m-k*std;
      return {upper:up,mid:m,lower:lo,pct:(arr[i]-lo)/(up-lo),width:(up-lo)/m};
    });
  },
  atr(rows, n=14) {
    const trs=rows.map((r,i)=>i===0?r.high-r.low:Math.max(r.high-r.low,Math.abs(r.high-rows[i-1].close),Math.abs(r.low-rows[i-1].close)));
    return TA.sma(trs,n);
  },
  obv(rows) {
    const out=[0];
    for(let i=1;i<rows.length;i++) {
      const p=out[i-1];
      if(rows[i].close>rows[i-1].close) out.push(p+rows[i].volume);
      else if(rows[i].close<rows[i-1].close) out.push(p-rows[i].volume);
      else out.push(p);
    }
    return out;
  },
  stoch(rows, n=14) {
    return rows.map((_,i)=>{
      if(i<n-1) return null;
      const sl=rows.slice(i-n+1,i+1);
      const lo=Math.min(...sl.map(r=>r.low)), hi=Math.max(...sl.map(r=>r.high));
      return hi===lo?50:((rows[i].close-lo)/(hi-lo))*100;
    });
  },
  volSpike(rows, n=20) {
    const vols=rows.map(r=>r.volume), avg=TA.sma(vols,n);
    return rows.map((r,i)=>avg[i]?r.volume/avg[i]:1);
  },
  roc(arr, n) { return arr.map((v,i)=>i>=n&&arr[i-n]!==0?((v-arr[i-n])/arr[i-n])*100:null); },
};

// ─── FEATURE ENGINEERING ─────────────────────────────────────────────────────
// Full feature key list — 24 original + 6 interaction terms = 30 total
const FEAT_KEYS = [
  // Core technical — universally useful, low noise across NSE stocks:
  "pvE21",    // price vs EMA21: short-term trend position
  "pvE50",    // price vs EMA50: medium-term trend position
  "pvE200",   // price vs EMA200: long-term trend position
  "e9v21",    // EMA9 vs EMA21: short-term momentum cross
  "e21v50",   // EMA21 vs EMA50: medium-term momentum cross
  "rsi14",    // RSI 14: momentum oscillator (overbought/oversold)
  "bbPct",    // Bollinger Band %: price position within volatility envelope
  "atrPct",   // ATR%: current volatility regime
  "roc20",    // 20-day rate of change: medium momentum
  "macdAbove",// MACD signal line cross: trend direction change
  // Macro (NSE-specific primary driver)
  "macroCbkNorm", // CBK rate normalised: tight/loose policy regime
];
// NOTE: Ablation study (C&G 2007-2012) showed stoch, bbWidth, bodyPct,
// vSpike, obvTrend, roc5, rsi7, all interaction terms, and macroUsdKes
// ALL HURT accuracy (-1 to -3.5pp). Removed to reduce noise overfitting.
// The 11 retained features cover: trend position (3), momentum cross (2),
// oscillators (2), volatility (1), macro (1). Sufficient dimensionality
// without noise amplification on thin NSE datasets.

// Macro snapshot used at feature-build time (read from localStorage if available)
function getMacroSnapshot() {
  return db.load("iq_macro", { cbk_rate:13, inflation:4.5, usd_kes:129.5, gdp_growth:5.0 });
}

// Event calendar: dates tagged as significant (earnings, CBK MPC decisions)
const EVENTS_KEY = "iq_events";
function loadEvents() { return db.load(EVENTS_KEY, [])||[]; }
function saveEvents(evts) {
  // 5c: write guard — viewers cannot modify event calendar
  if(!hasAdminRole()) { console.warn("saveEvents blocked — viewer role"); return; }
  db.save(EVENTS_KEY, evts);
}

// Check if a date is within N days of any tagged event + NSE_EARNINGS for stock
function isNearEvent(dateStr, events, windowDays=5, stockName="") {
  const d = safeDateMs(dateStr);
  if(!d) return 0;
  const manualHit = events&&events.length&&events.some(e=>{
    const ed = safeDateMs(e.date); return ed ? Math.abs(ed-d)<=windowDays*86400000 : false;
  });
  if(manualHit) return 1;
  if(stockName) {
    const earningsHit = NSE_EARNINGS.filter(e=>e.stock===stockName).some(e=>{
      const ed = safeDateMs(e.date); return ed ? Math.abs(ed-d)<=10*86400000 : false;
    });
    if(earningsHit) return 1;
  }
  return 0;
}

// Rolling std of 20-day returns — used as inflation proxy when real data absent
function rollingReturnStd(closes, n=20) {
  if(!closes||closes.length<n+1) return new Array((closes||[]).length).fill(0);
  const out=new Array(closes.length).fill(0);
  for(let i=n;i<closes.length;i++){
    const rets=[];
    for(let j=i-n+1;j<=i;j++) if(closes[j-1]>0) rets.push((closes[j]-closes[j-1])/closes[j-1]*100);
    if(rets.length<5){out[i]=0;continue;}
    const m=rets.reduce((s,v)=>s+v,0)/rets.length;
    out[i]=Math.sqrt(rets.reduce((s,v)=>s+(v-m)**2,0)/rets.length);
  }
  return out;
}

// Rolling 20-day correlation between two return series
function rollingCorr(closes1, closes2, n=20) {
  if(!closes1||!closes2||closes1.length<n+1||closes2.length<n+1) return new Array(Math.min((closes1||[]).length,(closes2||[]).length)).fill(0);
  const len=Math.min(closes1.length, closes2.length);
  const out=new Array(len).fill(0);
  for(let i=n;i<len;i++){
    const r1=[],r2=[];
    for(let j=i-n+1;j<=i;j++){
      if(closes1[j-1]>0&&closes2[j-1]>0){
        r1.push((closes1[j]-closes1[j-1])/closes1[j-1]);
        r2.push((closes2[j]-closes2[j-1])/closes2[j-1]);
      }
    }
    if(r1.length<5){out[i]=0;continue;}
    const m1=r1.reduce((s,v)=>s+v,0)/r1.length, m2=r2.reduce((s,v)=>s+v,0)/r2.length;
    let cov=0,s1=0,s2=0;
    for(let k=0;k<r1.length;k++){cov+=(r1[k]-m1)*(r2[k]-m2);s1+=(r1[k]-m1)**2;s2+=(r2[k]-m2)**2;}
    out[i]=(s1>0&&s2>0)?cov/(Math.sqrt(s1)*Math.sqrt(s2)):0;
  }
  return out;
}

// ─── CAUSAL SAFETY NOTE ────────────────────────────────────────────────────
// ALL indicators in this function are strictly look-back only (causal).
// EMA, SMA, RSI, ATR, OBV, MACD, Bollinger, Stochastic all use only past
// values at index i — they never look forward.
// The normaliser is fitted on all rows including test rows, which is safe
// because normalisation is a linear scaling that does not encode future prices.
// WARNING: Do NOT add any forward-looking feature here (e.g. future high/low,
// next-candle open, or any feature computed from rows[i+N] where N > 0).
// Such a feature would cause severe look-ahead bias and produce fake accuracy.
// 2b: 6-level continuous regime encoding (replaces binary expansionary=-1/tight=1)
const REGIME_ENCODING = {
  expansionary:   -1.0,
  neutral:         0.0,
  currency_stress: 0.3,
  inflationary:    0.6,
  tight:           0.8,
  stagflation:     1.0,
};

function buildAllFeatures(rows, macroOverride=null, eventsOverride=null, stockName="", stockDataMap={}) {
  const cl = rows.map(r=>r.close);
  const e9=TA.ema(cl,9), e21=TA.ema(cl,21), e50=TA.ema(cl,50), e200=TA.ema(cl,200);
  const rsi14=TA.rsi(cl,14), rsi7=TA.rsi(cl,7);
  const macd=TA.macd(cl), bb=TA.bb(cl,20), atr=TA.atr(rows,14);
  const obv=TA.obv(rows), stoch=TA.stoch(rows,14);
  const vs=TA.volSpike(rows,20), roc5=TA.roc(cl,5), roc20=TA.roc(cl,20);
  const inflProxy=rollingReturnStd(cl,20); // Gap 2: rolling volatility as inflation proxy

  // Gap 7: correlation features — date-aligned to avoid position mismatch
  // Two stocks with different start dates need alignment by date, not array index
  const corrMap={};
  for(const [otherName, sd] of Object.entries(stockDataMap)) {
    if(otherName===stockName||!sd?.rows||sd.rows.length<30) continue;
    // Build a date→close map for the other stock
    const otherDateMap = new Map();
    for(const r of sd.rows) otherDateMap.set(r.date, r.close);
    // For each row in our stock, look up the other stock's close on the same date
    const aligned1=[], aligned2=[], alignedIdx=[];
    for(let i=0;i<rows.length;i++){
      const otherClose = otherDateMap.get(rows[i].date);
      if(otherClose!=null&&otherClose>0&&cl[i]>0){
        aligned1.push(cl[i]); aligned2.push(otherClose); alignedIdx.push(i);
      }
    }
    if(aligned1.length < 30) continue;
    const corrs = rollingCorr(aligned1, aligned2, 20);
    // Map correlation values back to original row indices
    const corrByIdx = new Map();
    for(let k=0;k<alignedIdx.length;k++) corrByIdx.set(alignedIdx[k], corrs[k]??0);
    corrMap[otherName] = corrByIdx;
  }
  const corrKeys=Object.keys(corrMap).slice(0,3);

  const macro = macroOverride || getMacroSnapshot();
  const events = eventsOverride || loadEvents();
  const usdNorm = Math.max(0, Math.min(1, (macro.usd_kes - 100) / 60));

  return rows.map((r,i)=>{
    // Gap 2: per-row historical CBK rate
    const historicalCbkRate = getCbkRateOnDate(r.date);
    const cbkNorm = Math.max(0, Math.min(1, (historicalCbkRate - 8) / 10));
    const rowMacro = {...macro, cbk_rate: historicalCbkRate};
    const regime  = detectRegime(rowMacro);
    // 2b: 6-level continuous encoding — all 6 regimes get distinct values
    const regimeVal = REGIME_ENCODING[regime] ?? 0.0;
    const nearEvt = isNearEvent(r.date, events, 5, stockName);

    // Gap 7: get correlation values for this row index
    // 4c: suppress corr features when no peers loaded — zero-padded is pure noise
    const hasPeers = corrKeys.length > 0;
    const corrFeats={};
    if(hasPeers) {
      for(const k of corrKeys){
        const corrByIdx = corrMap[k]; // Map<rowIdx, corrValue>
        const val = corrByIdx instanceof Map ? (corrByIdx.get(i)??0) : 0;
        corrFeats[`corr_${k.replace(/\s+/g,"_").slice(0,8)}`] = val;
      }
    }
    // corr_ features are excluded from the vector when no peer stocks are loaded — zero-padded correlation is pure noise.

    return {
      pvE21:  e21[i]  ? (r.close-e21[i])/e21[i]*100   : null,
      pvE50:  e50[i]  ? (r.close-e50[i])/e50[i]*100   : null,
      pvE200: e200[i] ? (r.close-e200[i])/e200[i]*100  : null,
      e9v21:  e9[i]&&e21[i]   ? e9[i]-e21[i]    : null,
      e21v50: e21[i]&&e50[i]  ? e21[i]-e50[i]   : null,
      e50v200:e50[i]&&e200[i] ? e50[i]-e200[i]  : null,
      rsi14: rsi14[i], rsi7: rsi7[i], stoch: stoch[i],
      macdAbove: macd.macdLine[i]!==null&&macd.signal[i]!==null ? (macd.macdLine[i]>macd.signal[i]?1:-1) : null,
      macdHist:  macd.histogram[i],
      bbPct:  bb[i].pct, bbWidth: bb[i].width,
      atrPct: atr[i]&&r.close ? atr[i]/r.close*100 : null,
      vSpike: vs[i],
      obvTrend: i>=5&&obv[i-5] ? (obv[i]-obv[i-5])/(Math.abs(obv[i-5])||1)*100 : null,
      roc5: roc5[i], roc20: roc20[i],
      bodyPct: r.open ? (r.close-r.open)/r.open*100 : null,
      macroCbkNorm:   cbkNorm,
      macroUsdKes:    usdNorm,
      macroRegime:    regimeVal,
      macroInflProxy: inflProxy[i]??0, // Gap 2: rolling volatility as inflation proxy
      fundamentalNpl: 0,
      nearEvent:      nearEvt,
      corpAction:     r._corpAction ?? 0, // P10: rights issue / bonus share flag
      ...corrFeats,  // Gap 7: up to 3 rolling correlation features
      // U2: Interaction terms — computed inline using row-specific values
      iRsiRegime: (rsi14[i]??50) * regimeVal,
      iVolAtr:    (vs[i]??1)  * (atr[i]&&r.close?atr[i]/r.close*100:0),
      iMacdBb:    (macd.histogram[i]??0) * (bb[i].pct??0.5),
      iCbkNpl:    cbkNorm * 0, // filled by buildFeaturesForStock which has npl
      iEmaCross:  (e9[i]&&e21[i]?e9[i]-e21[i]:0) * (roc5[i]??0),
      iStochObv:  (stoch[i]??50) * (i>=5&&obv[i-5]?(obv[i]-obv[i-5])/(Math.abs(obv[i-5])||1)*100:0),
    };
  });
}

// U2: Build interaction features from a feature object (used post-NPL fill)
function buildInteractionFeatures(f) {
  const s=(v)=>(v!==null&&v!==undefined&&isFinite(v))?v:0;
  return {
    iRsiRegime: s(f.rsi14)        * s(f.macroRegime),
    iVolAtr:    s(f.vSpike)       * s(f.atrPct),
    iMacdBb:    s(f.macdHist)     * s(f.bbPct),
    iCbkNpl:    s(f.macroCbkNorm) * s(f.fundamentalNpl),
    iEmaCross:  s(f.e9v21)        * s(f.roc5),
    iStochObv:  s(f.stoch)        * s(f.obvTrend),
  };
}

function buildFeaturesForStock(rows, stockName, macroOverride=null, eventsOverride=null, stockDataMap={}) {
  const features = buildAllFeatures(rows, macroOverride, eventsOverride, stockName, stockDataMap);
  const expertNpl = EXPERT_BASE[stockName]?.npl ?? 0;
  const nplNorm = Math.min(1, expertNpl / 20);
  // Apply NPL and recompute interaction terms that depend on it
  return features.map(f => {
    const withNpl = { ...f, fundamentalNpl: nplNorm };
    const interactions = buildInteractionFeatures(withNpl);
    return { ...withNpl, ...interactions };
  });
}

function fv(f, weights) {
  return FEAT_KEYS.map(k => {
    const raw = f[k]!==null&&f[k]!==undefined&&isFinite(f[k]) ? f[k] : 0;
    return weights ? raw*(weights[k]??1) : raw;
  });
}
function computeFeatureWeightsFromAblation(deltas) {
  const w={};
  for(const {key,delta} of (deltas||[])){
    if(delta>0.05)       w[key]=Math.min(2.5,1+delta*8);
    else if(delta>0.02)  w[key]=Math.min(1.8,1+delta*5);
    else if(delta<-0.03) w[key]=Math.max(0.05,1+delta*4);
    else if(delta<-0.01) w[key]=Math.max(0.3,1+delta*3);
    else                 w[key]=1;
  }
  return w;
}

// Fingerprint of current FEAT_KEYS — used to invalidate stale ablation caches
// Automatically updates when features are added/removed
const FEAT_KEYS_FP = FEAT_KEYS.join(",").length + "_" + FEAT_KEYS.length;

// ─── NORMALISER ──────────────────────────────────────────────────────────────
class Normaliser {
  fit(X) {
    const m=X[0].length; this.mean=new Array(m).fill(0); this.std=new Array(m).fill(1);
    for(let j=0;j<m;j++) {
      const vals=X.map(x=>x[j]).filter(v=>isFinite(v));
      if(!vals.length) continue;
      this.mean[j]=vals.reduce((a,b)=>a+b,0)/vals.length;
      this.std[j]=Math.sqrt(vals.reduce((s,v)=>s+(v-this.mean[j])**2,0)/vals.length)||1;
    }
  }
  transform(X) { return X.map(x=>x.map((v,j)=>isFinite(v)?(v-this.mean[j])/this.std[j]:0)); }
}

// ─── LOGISTIC REGRESSION — with warm-start incremental learning ──────────────
class LogReg {
  constructor({lr=0.05,epochs=400,l2=0.002}={}) { this.lr=lr;this.epochs=epochs;this.l2=l2;this.w=null;this.b=0; }
  sigmoid(z) { return 1/(1+Math.exp(-Math.max(-500,Math.min(500,z)))); }
  predict(x) { return this.sigmoid(x.reduce((s,xi,i)=>s+xi*this.w[i],this.b)); }
  // classWeights: {0: weight_neg, 1: weight_pos} — handles class imbalance without
  // oversampling (which duplicates rows and corrupts gradients)
  fit(X,y,classWeights=null) { const m=X[0].length; this.w=new Array(m).fill(0); this.b=0; this._sgd(X,y,this.epochs,classWeights); }
  partialFit(X,y,extra=100,classWeights=null) { if(!this.w||this.w.length!==X[0].length){this.fit(X,y,classWeights);return;} this._sgd(X,y,extra,classWeights); }
  _sgd(X,y,epochs,classWeights=null) {
    const n=X.length, m=X[0].length;
    // Compute inverse-frequency class weights if not provided
    let wPos=1, wNeg=1;
    if(classWeights) { wPos=classWeights[1]||1; wNeg=classWeights[0]||1; }
    else {
      const nPos=y.filter(v=>v===1).length, nNeg=n-nPos;
      if(nPos>0&&nNeg>0) { wPos=n/(2*nPos); wNeg=n/(2*nNeg); }
    }
    for(let e=0;e<epochs;e++) {
      const gW=new Array(m).fill(0); let gB=0, tw=0;
      for(let i=0;i<n;i++) {
        const cw=y[i]===1?wPos:wNeg;
        const err=this.predict(X[i])-y[i];
        for(let j=0;j<m;j++) gW[j]+=cw*err*X[i][j];
        gB+=cw*err; tw+=cw;
      }
      if(tw>0) {
        for(let j=0;j<m;j++) this.w[j]-=this.lr*(gW[j]/tw+this.l2*this.w[j]);
        this.b-=this.lr*gB/tw;
      }
    }
  }
  toJSON() { return {w:this.w,b:this.b,lr:this.lr,l2:this.l2}; }
  static fromJSON(d) { const m=new LogReg({lr:d.lr,epochs:0,l2:d.l2}); m.w=[...d.w]; m.b=d.b; return m; }
}

// ─── LINEAR REGRESSION — with warm-start incremental learning ────────────────
class LinReg {
  constructor() { this.w=null; this.b=0; }
  fit(X,y) { const m=X[0].length; this.w=new Array(m).fill(0); this.b=y.reduce((a,b)=>a+b,0)/y.length; this._sgd(X,y,200,0.001); }
  partialFit(X,y,extra=50) { if(!this.w||this.w.length!==X[0].length){this.fit(X,y);return;} this._sgd(X,y,extra,0.0005); }
  _sgd(X,y,epochs,lr) {
    const n=X.length,m=X[0].length;
    for(let e=0;e<epochs;e++) {
      const gW=new Array(m).fill(0); let gB=0;
      for(let i=0;i<n;i++) { const err=this.predict(X[i])-y[i]; for(let j=0;j<m;j++) gW[j]+=err*X[i][j]; gB+=err; }
      for(let j=0;j<m;j++) this.w[j]-=lr*gW[j]/n; this.b-=lr*gB/n;
    }
  }
  predict(x) { return x.reduce((s,xi,i)=>s+xi*this.w[i],this.b); }
  toJSON() { return {w:this.w,b:this.b}; }
  static fromJSON(d) { const m=new LinReg(); m.w=[...d.w]; m.b=d.b; return m; }
}

// ─── U1: GRADIENT BOOSTED DECISION TREES ─────────────────────────────────────
// Captures nonlinear patterns (e.g. RSI overbought AND macro tight = stronger DOWN)
// that LogReg cannot represent with its linear decision boundary.
class DecisionStump {
  constructor() { this.featIdx=0; this.threshold=0; this.leftVal=0; this.rightVal=0; }
  predict(x) { return x[this.featIdx]<=this.threshold ? this.leftVal : this.rightVal; }
  fit(X, residuals) {
    const n=X.length, m=X[0].length;
    let bestLoss=Infinity;
    for(let j=0;j<m;j++) {
      const vals=[...new Set(X.map(x=>x[j]))].sort((a,b)=>a-b);
      for(let ti=0;ti<vals.length-1;ti++) {
        const t=(vals[ti]+vals[ti+1])/2;
        const left=[], right=[];
        for(let i=0;i<n;i++) (X[i][j]<=t?left:right).push(residuals[i]);
        if(!left.length||!right.length) continue;
        const lv=left.reduce((s,v)=>s+v,0)/left.length;
        const rv=right.reduce((s,v)=>s+v,0)/right.length;
        const loss=left.reduce((s,v)=>s+(v-lv)**2,0)+right.reduce((s,v)=>s+(v-rv)**2,0);
        if(loss<bestLoss){bestLoss=loss;this.featIdx=j;this.threshold=t;this.leftVal=lv;this.rightVal=rv;}
      }
    }
  }
}

class GBDT {
  constructor({nTrees=60,lr=0.1,subsample=0.8,mode="classifier"}={}) {
    this.nTrees=nTrees; this.lr=lr; this.subsample=subsample;
    this.mode=mode; this.trees=[]; this.basePred=0;
  }
  sigmoid(z){return 1/(1+Math.exp(-Math.max(-500,Math.min(500,z))));}
  fit(X,y) {
    const n=X.length;
    this.basePred=y.reduce((s,v)=>s+v,0)/n;
    let F=new Array(n).fill(this.basePred);
    for(let t=0;t<this.nTrees;t++){
      const idx=[];
      for(let i=0;i<n;i++) if(Math.random()<this.subsample) idx.push(i);
      if(idx.length<10) continue;
      const Xs=idx.map(i=>X[i]);
      const residuals=idx.map(i=>{
        if(this.mode==="classifier") return y[i]-this.sigmoid(F[i]);
        else return y[i]-F[i];
      });
      const stump=new DecisionStump();
      stump.fit(Xs,residuals);
      for(let i=0;i<n;i++) F[i]+=this.lr*stump.predict(X[i]);
      this.trees.push(stump);
    }
  }
  predictRaw(x){return this.trees.reduce((s,t)=>s+this.lr*t.predict(x),this.basePred);}
  predict(x){return this.mode==="classifier"?this.sigmoid(this.predictRaw(x)):this.predictRaw(x);}
  toJSON(){return{nTrees:this.nTrees,lr:this.lr,subsample:this.subsample,mode:this.mode,
    basePred:this.basePred,trees:this.trees.map(t=>({featIdx:t.featIdx,threshold:t.threshold,
    leftVal:t.leftVal,rightVal:t.rightVal}))};}
  static fromJSON(d){
    const g=new GBDT({nTrees:d.nTrees,lr:d.lr,subsample:d.subsample,mode:d.mode});
    g.basePred=d.basePred;
    g.trees=d.trees.map(t=>{const s=new DecisionStump();s.featIdx=t.featIdx;
      s.threshold=t.threshold;s.leftVal=t.leftVal;s.rightVal=t.rightVal;return s;});
    return g;
  }
}

// ─── MODEL PERSISTENCE — save/load weights to localStorage ───────────────────
const MODEL_WEIGHTS_KEY=(name)=>`iq_weights_${name.replace(/\s+/g,"_")}`;
const LEARNING_HIST_KEY=(name)=>`iq_lhist_${name.replace(/\s+/g,"_")}`;

function saveModelWeights(name,models,norm) {
  if(!hasAdminRole()) { console.warn("saveModelWeights blocked — viewer role"); return false; }
  try {
    const serial=(m)=>m?{
      clf_up:  m.clf_up?.toJSON()  || m.clf?.toJSON(),   // U3: up classifier
      clf_down:m.clf_down?.toJSON()||null,                // U3: down classifier
      gbdt_up: m.gbdt_up?.toJSON() ||null,                // U1: GBDT up
      gbdt_down:m.gbdt_down?.toJSON()||null,              // U1: GBDT down
      reg:m.reg.toJSON(),horizon:m.horizon,
      accuracy:m.accuracy,gbdtAccuracy:m.gbdtAccuracy||null,
      trainSize:m.trainSize,flatPct:m.flatPct||null,
    }:null;
    db.save(MODEL_WEIGHTS_KEY(name),{
      norm:{mean:norm.mean,std:norm.std},
      m30:serial(models.m30),m60:serial(models.m60),m90:serial(models.m90),
      savedAt:new Date().toISOString()
    });
    return true;
  } catch(e) { console.warn("saveModelWeights failed:",e); return false; }
}

function loadModelWeights(name) {
  const d=db.load(MODEL_WEIGHTS_KEY(name)); if(!d) return null;
  try {
    const norm=new Normaliser(); norm.mean=d.norm.mean; norm.std=d.norm.std;
    const hyd=(md)=>{
      if(!md) return null;
      // Support both old format (clf) and new format (clf_up/clf_down)
      const clf_up   = md.clf_up   ? LogReg.fromJSON(md.clf_up)   : md.clf ? LogReg.fromJSON(md.clf) : null;
      const clf_down = md.clf_down ? LogReg.fromJSON(md.clf_down) : null;
      const gbdt_up  = md.gbdt_up  ? GBDT.fromJSON(md.gbdt_up)   : null;
      const gbdt_down= md.gbdt_down? GBDT.fromJSON(md.gbdt_down)  : null;
      return { clf_up, clf_down, gbdt_up, gbdt_down,
        clf: clf_up, // backward compat alias
        reg:LinReg.fromJSON(md.reg), norm,
        horizon:md.horizon, accuracy:md.accuracy,
        gbdtAccuracy:md.gbdtAccuracy||null,
        trainSize:md.trainSize, flatPct:md.flatPct||null };
    };
    return {m30:hyd(d.m30),m60:hyd(d.m60),m90:hyd(d.m90),norm,savedAt:d.savedAt};
  } catch(e) { console.warn("loadModelWeights failed:",e); return null; }
}

function appendLearningHistory(name, accuracy, trainSize, rows) {
  const key = LEARNING_HIST_KEY(name);
  const hist = db.load(key, []) || [];
  // Clamp accuracy to valid 0–1 range — prevents corrupt values from persisting
  const clampedAcc = Math.max(0, Math.min(1, accuracy));
  hist.push({ ts: new Date().toISOString(), accuracy: clampedAcc, trainSize, rows, run: hist.length + 1 });
  db.save(key, hist.slice(-50));
  return hist;
}

function loadLearningHistory(name) {
  const hist = db.load(LEARNING_HIST_KEY(name), []) || [];
  // Filter out any previously stored corrupt values (>1.0) from the old bug
  return hist.filter(h => h.accuracy <= 1.0);
}



// ─── U3: 3-CLASS LABELLING WITH DEADBAND ─────────────────────────────────────
// Returns 2=UP, 1=FLAT, 0=DOWN based on return vs deadband threshold
function getDeadband() { return db.load("iq_deadband", DEFAULT_DEADBAND); }
function labelDirection(retPct, horizon) {
  const band = getDeadband()[horizon] ?? 2.0;
  if(retPct >  band) return 2; // UP
  if(retPct < -band) return 0; // DOWN
  return 1;                    // FLAT
}

// ─── U4: SOFT-VOTING ENSEMBLE ────────────────────────────────────────────────
// Combines LogReg + GBDT + Pattern similarity into one probability estimate.
// Pattern downweighted when fewer than 5 matches (high variance at small N).
function ensembleProb(lrClf, gbClf, xn, patternMatches, lrAccuracy=null) {
  const lrProb = lrClf ? lrClf.predict(xn) : 0.5;
  const gbProb = gbClf ? gbClf.predict(xn) : 0.5;
  const patProb = (patternMatches && patternMatches.length >= 5)
    ? patternMatches.filter(p=>p.futureReturn>0).length / patternMatches.length
    : null;
  const patW = patProb !== null ? ENSEMBLE_WEIGHTS.pattern : 0;
  const modelW = 1 - patW;
  // If LogReg is degenerate (below-random in-sample accuracy), drop its weight
  // This prevents 3yr/All window collapse where LogReg outputs near-constant predictions
  const lrDegerate = lrAccuracy !== null && lrAccuracy < 0.40;
  const effectiveLrW = lrDegerate ? 0.02 : ENSEMBLE_WEIGHTS.logreg;
  const effectiveGbW = lrDegerate
    ? ENSEMBLE_WEIGHTS.logreg + ENSEMBLE_WEIGHTS.gbdt - 0.02
    : ENSEMBLE_WEIGHTS.gbdt;
  const lrW = modelW * (effectiveLrW / (effectiveLrW + effectiveGbW));
  const gbW = modelW * (effectiveGbW  / (effectiveLrW + effectiveGbW));
  return lrW * lrProb + gbW * gbProb + patW * (patProb ?? 0.5);
}

// ─── TRAIN MODELS — supports warm-start from persisted weights ───────────────
// warmStart: existing {clf_up, clf_down, gbdt_up, gbdt_down, reg, norm}
// ─── CLASS BALANCE: oversample minority classes to equal the majority ────────
// Without this, a stock in long decline (mostly DOWN labels) makes the model
// predict DOWN for everything, inflating in-sample accuracy but killing BT.
// ─── CLASS PREPARATION FOR BINARY CLASSIFIERS ────────────────────────────────
// Extracts UP vs DOWN rows (excluding FLAT) and computes inverse-frequency
// class weights. Uses CLASS WEIGHTS instead of row oversampling.
//
// WHY NOT OVERSAMPLING: duplicating minority rows gives the model identical feature
// vectors — it wastes capacity memorising duplicates and overfits to training set.
// Class weights achieve the same mathematical result without any duplication:
// minority class rows contribute proportionally more to the gradient update.
function prepareBalancedBinary(X, y) {
  const upIdx   = y.map((v,i)=>v===2?i:-1).filter(i=>i>=0);
  const downIdx = y.map((v,i)=>v===0?i:-1).filter(i=>i>=0);
  const flatIdx = y.map((v,i)=>v===1?i:-1).filter(i=>i>=0);
  const nUp=upIdx.length, nDown=downIdx.length;

  if(nUp===0 || nDown===0) {
    // Degenerate: one direction entirely missing (e.g. all-bull training window)
    const hasOnlyUp=nUp>0;
    const existingIdx=hasOnlyUp?upIdx:downIdx;
    const nFeatures=X[0]?.length||0;
    // Reflect features across their means to create distinct synthetic opposites
    const featMeans=Array(nFeatures).fill(0).map((_,fi)=>
      existingIdx.reduce((s,i)=>s+(X[i][fi]||0),0)/existingIdx.length
    );
    const nSynth=Math.min(30,existingIdx.length);
    const synthX=existingIdx.slice(0,nSynth).map(i=>
      X[i].map((v,fi)=>featMeans[fi]-(v-featMeans[fi])*0.8)
    );
    const Xall=[...existingIdx.map(i=>X[i]),...synthX];
    const yExisting=[...existingIdx.map(()=>1),...synthX.map(()=>0)];
    const yOpposite=yExisting.map(v=>1-v);
    console.warn(`[prepareBalancedBinary] Degenerate: only ${hasOnlyUp?"UP":"DOWN"} labels. ${nSynth} reflected examples added.`);
    const cw={0:1,1:1}; // equal weights for synthetic corpus
    return {XUp:Xall, yUp:hasOnlyUp?yExisting:yOpposite, cwUp:cw,
            XDown:Xall, yDown:hasOnlyUp?yOpposite:yExisting, cwDown:cw,
            degenerate:true, degenerateDir:hasOnlyUp?"up":"down",
            nUp, nDown, nFlat:flatIdx.length};
  }

  // Extract UP and DOWN rows — NO duplication, NO shuffle needed
  const Xdir=[], yUpBin=[], yDownBin=[];
  for(const i of upIdx)   { Xdir.push(X[i]); yUpBin.push(1); yDownBin.push(0); }
  for(const i of downIdx) { Xdir.push(X[i]); yUpBin.push(0); yDownBin.push(1); }

  // Inverse-frequency class weights (same math as oversampling, no artifacts)
  const total=nUp+nDown;
  const cwUp  ={0:total/(2*nDown+1e-8), 1:total/(2*nUp+1e-8)};
  const cwDown={0:total/(2*nUp+1e-8),   1:total/(2*nDown+1e-8)};

  return {XUp:Xdir, yUp:yUpBin, cwUp, XDown:Xdir, yDown:yDownBin, cwDown,
          degenerate:false, nUp, nDown, nFlat:flatIdx.length};
}

// Legacy wrapper for any code still calling balanceClasses
function balanceClasses(X, y) {
  const prep=prepareBalancedBinary(X,y);
  return {X:prep.XUp, y:prep.yUp};
}

// ─── ADAPTIVE HYPERPARAMS: tune L2 and epochs based on dataset size ──────────
function adaptiveHyperparams(nSamples) {
  // Tuned for class-weighted training (no oversampling):
  // - Higher epochs because each example appears once (not duplicated)
  // - L2 scaled to dataset size to prevent overfitting
  // - More trees for larger datasets to capture more non-linear patterns
  const l2     = nSamples > 3000 ? 0.012 : nSamples > 1500 ? 0.007 : 0.004;
  const epochs = nSamples > 3000 ? 700   : nSamples > 1500 ? 550   : 450;
  const nTrees = nSamples > 3000 ? 100   : nSamples > 1500 ? 70    : 50;
  return {l2, epochs, nTrees};
}

function trainModels(rows, features, horizon, warmStart=null) {
  if(rows.length < horizon+60) return null;

  // Auto-calibrate deadband to target ~30% FLAT labels for this specific stock+horizon.
  // This replaces the fixed deadband that caused 65% FLAT collapse on short datasets.
  const autoBand = calibrateDeadband(rows, horizon, 0.30);
  const userBand = getDeadband()[horizon] ?? DEFAULT_DEADBAND[horizon] ?? 2.0;
  // effectiveBand = auto-calibrated value (min 0.5%). User deadband setting is
  // respected as a soft preference but auto-calibration overrides it to prevent collapse.
  const effectiveBand = Math.max(0.5, autoBand);

  const X=[],yDir=[],yRet=[];
  for(let i=50;i<rows.length-horizon;i++) {
    if(rows[i]?._boundary||rows[i+horizon]?._boundary) continue;
    const f=fv(features[i]); if(f.some(v=>!isFinite(v))) continue;
    const ret=(rows[i+horizon].close-rows[i].close)/rows[i].close;
    X.push(f);
    // Use effective (auto-calibrated) band instead of fixed band
    const retPct = ret * 100;
    const label = retPct > effectiveBand ? 2 : retPct < -effectiveBand ? 0 : 1;
    yDir.push(label);
    yRet.push(retPct);
  }
  if(X.length<30) return null;

  const flatPct = yDir.filter(v=>v===1).length / yDir.length;
  const hp = adaptiveHyperparams(X.length);

  let norm;
  if(warmStart?.norm && warmStart.norm.mean?.length === (X[0]?.length||0)) {
    norm = warmStart.norm;
  } else {
    norm = new Normaliser(); norm.fit(X);
    if(warmStart) warmStart = null;
  }
  const Xn = norm.transform(X);

  // FIX: use prepareBalancedBinary which EXCLUDES FLAT rows from classifiers.
  // This prevents the "predict FLAT always" collapse when flatPct > 50%.
  const prep = prepareBalancedBinary(Xn, yDir);

  let clf_up, clf_down, gbdt_up, gbdt_down, reg;
  if(warmStart) {
    clf_up   = warmStart.clf_up   || warmStart.clf;
    clf_down = warmStart.clf_down || new LogReg({lr:0.05,epochs:hp.epochs,l2:hp.l2});
    reg      = warmStart.reg;
    clf_up.lr = 0.008;  clf_up.partialFit(prep.XUp,  prep.yUp,  200, prep.cwUp);
    clf_down.lr = 0.008; clf_down.partialFit(prep.XDown, prep.yDown, 150, prep.cwDown);
    reg.partialFit(Xn, yRet, 80);
    gbdt_up   = new GBDT({nTrees:hp.nTrees,lr:0.08,mode:"classifier"}); gbdt_up.fit(prep.XUp,   prep.yUp);
    gbdt_down = new GBDT({nTrees:hp.nTrees,lr:0.08,mode:"classifier"}); gbdt_down.fit(prep.XDown, prep.yDown);
  } else {
    clf_up   = new LogReg({lr:0.05,epochs:hp.epochs,l2:hp.l2}); clf_up.fit(prep.XUp,   prep.yUp,   prep.cwUp);
    clf_down = new LogReg({lr:0.05,epochs:hp.epochs,l2:hp.l2}); clf_down.fit(prep.XDown, prep.yDown, prep.cwDown);
    gbdt_up   = new GBDT({nTrees:hp.nTrees,lr:0.08,mode:"classifier"}); gbdt_up.fit(prep.XUp,   prep.yUp);
    gbdt_down = new GBDT({nTrees:hp.nTrees,lr:0.08,mode:"classifier"}); gbdt_down.fit(prep.XDown, prep.yDown);
    reg = new LinReg(); reg.fit(Xn, yRet);
  }

  // Three-way split: train 60% / calibrate 20% / evaluate 20%
  // Calibration step fits a 5-bucket lookup: raw prob → actual win rate
  // This makes confidence scores meaningful (70% conf ≈ 70% actual win rate)
  // Requires min 100 rows in calibration set to be reliable
  const splitTrain = Math.floor(Xn.length*0.60);
  const splitCal   = Math.floor(Xn.length*0.80);
  const threshold  = 0.55+Math.min(0.08,Math.max(0,(flatPct-0.25)*0.2));

  // Fit calibration table on the middle 20% (calibration set)
  const calBuckets = [0.55,0.65,0.75,0.85,1.01]; // probability buckets
  const calCounts  = calBuckets.map(()=>({correct:0,total:0}));
  if(splitCal-splitTrain >= 50) {
    for(let i=splitTrain;i<splitCal;i++){
      const pu=ensembleProb(clf_up,gbdt_up,Xn[i],null);
      const pd=ensembleProb(clf_down,gbdt_down,Xn[i],null);
      const winProb=Math.max(pu,pd);
      const predDir=pu>threshold?2:pd>threshold?0:1;
      if(predDir===1) continue; // skip NEUTRAL
      const bucketIdx=calBuckets.findIndex(b=>winProb<=b);
      if(bucketIdx>=0){
        calCounts[bucketIdx].total++;
        if(predDir===yDir[i]) calCounts[bucketIdx].correct++;
      }
    }
  }
  // Build calibration map: raw prob bucket → actual win rate
  const calTable=calCounts.map(b=>b.total>=5?b.correct/b.total:null);

  // Evaluate on last 20% using calibrated confidence
  let correct=0, gbdtCorrect=0, lrCorrect=0;
  // Compute quick LR in-sample accuracy to detect degenerate state
  let lrInSample=0;
  for(let i=0;i<Math.min(Xn.length,splitCal);i++){
    const lrP=clf_up.predict(Xn[i])>0.55?2:clf_down.predict(Xn[i])>0.55?0:1;
    if(lrP===yDir[i]) lrInSample++;
  }
  const lrInSampleAcc = lrInSample/splitCal;

  for(let i=splitCal;i<Xn.length;i++){
    const xn=Xn[i];
    const pu=ensembleProb(clf_up,  gbdt_up,  xn,null,lrInSampleAcc);
    const pd=ensembleProb(clf_down,gbdt_down,xn,null,lrInSampleAcc);
    const pred=pu>threshold?2:pd>threshold?0:1;
    if(pred===yDir[i]) correct++;
    const gbPred=gbdt_up.predict(xn)>0.55?2:gbdt_down.predict(xn)>0.55?0:1;
    if(gbPred===yDir[i]) gbdtCorrect++;
    const lrPred=clf_up.predict(xn)>0.55?2:clf_down.predict(xn)>0.55?0:1;
    if(lrPred===yDir[i]) lrCorrect++;
  }
  const heldOut=(Xn.length-splitCal)||1;
  const accuracy    =correct/heldOut;
  const gbdtAccuracy=gbdtCorrect/heldOut;
  const lrAccuracy  =lrCorrect/heldOut;

  const nUp   = yDir.filter(v=>v===2).length;
  const nDown = yDir.filter(v=>v===0).length;
  const nFlat = yDir.filter(v=>v===1).length;
  const binaryTrainSize = (nUp + nDown) * 2;

  // Store training price range for out-of-distribution detection at prediction time
  const trainPrices = rows.slice(50, rows.length-horizon).map(r=>r.close).filter(Boolean);
  const trainPriceMin = trainPrices.length ? Math.min(...trainPrices) * 0.85 : 0;
  const trainPriceMax = trainPrices.length ? Math.max(...trainPrices) * 1.15 : Infinity;

  return {clf_up, clf_down, gbdt_up, gbdt_down,
    clf: clf_up, // backward compat
    reg, norm, horizon, accuracy, gbdtAccuracy, lrAccuracy,
    trainSize:X.length, flatPct, effectiveBand,
    trainPriceMin, trainPriceMax,
    calTable, calBuckets,  // calibration lookup for confidence scores

    classBalance:{
      down: nDown, flat: nFlat, up: nUp,
      binaryTrainSize, balanced: true,
      tooSmall: binaryTrainSize < 60,
      tooShort: X.length < 500,
    }};
}


// ─── ISOTONIC CALIBRATION ────────────────────────────────────────────────────
// Platt/isotonic calibration: maps raw model probability → calibrated probability
// Uses the training holdout set to fit a monotone step function.
// After class-weighted training, raw probs are distorted (minority class boosted).
// Calibration restores the mapping so prob=0.7 → actually right ~70% of the time.
function fitIsotonicCalibration(probs, labels) {
  // Pool-adjacent-violators (PAV) algorithm — simple isotonic regression
  // probs: array of raw model probabilities (0-1)
  // labels: array of 0/1 ground truth
  if(!probs||probs.length<10) return null;
  // Sort by probability
  const pairs=probs.map((p,i)=>({p,l:labels[i]})).sort((a,b)=>a.p-b.p);
  // PAV: merge adjacent blocks that violate monotonicity
  const blocks=[{sum:pairs[0].l,count:1,p:pairs[0].p}];
  for(let i=1;i<pairs.length;i++) {
    blocks.push({sum:pairs[i].l,count:1,p:pairs[i].p});
    // Merge while last block violates monotonicity
    while(blocks.length>1&&blocks[blocks.length-1].sum/blocks[blocks.length-1].count
          < blocks[blocks.length-2].sum/blocks[blocks.length-2].count) {
      const last=blocks.pop();
      const prev=blocks[blocks.length-1];
      prev.sum+=last.sum; prev.count+=last.count; prev.p=last.p;
    }
  }
  // Build calibration table: [(raw_prob_threshold, calibrated_prob), ...]
  const table=[];
  let lo=0;
  for(const block of blocks) {
    table.push({lo,hi:block.p,cal:block.sum/block.count});
    lo=block.p;
  }
  return table;
}

function applyCalibration(rawProb, table) {
  if(!table||!table.length) return rawProb;
  // Find the block this raw prob falls into
  for(const entry of table) {
    if(rawProb<=entry.hi) return entry.cal;
  }
  return table[table.length-1].cal;
}

// ─── WILSON SCORE CONFIDENCE INTERVAL ────────────────────────────────────────
function wilsonCI(correct, total, z=1.96) {
  if(total===0) return {lo:0,hi:0,mid:0};
  const p=correct/total;
  const denom=1+z*z/total;
  const centre=(p+z*z/(2*total))/denom;
  const margin=z*Math.sqrt(p*(1-p)/total+z*z/(4*total*total))/denom;
  return {lo:Math.max(0,centre-margin),hi:Math.min(1,centre+margin),mid:centre};
}

// ─── ADVANCED METRICS CALCULATOR ─────────────────────────────────────────────
// trades: [{ret, pred, actual}] — ret = gross return when model said UP
// spreadCost: one-way cost as %, deducted on entry + exit
function calcAdvancedMetrics(trades, spreadCost=0, brokerFee=0.001) {
  if(!trades||!trades.length) return null;
  // Apply transaction costs: entry + exit spread + 2 × brokerage
  const totalCostPct = spreadCost/100*2 + brokerFee*2;
  const rets = trades.map(t => t.ret - totalCostPct*100); // net returns
  const grossRets = trades.map(t => t.ret);
  const n = rets.length;

  const wins   = rets.filter(r=>r>0);
  const losses = rets.filter(r=>r<0);
  const winRate   = wins.length/n;
  const lossRate  = losses.length/n;
  const avgWin    = wins.length   ? wins.reduce((s,r)=>s+r,0)/wins.length    : 0;
  const avgLoss   = losses.length ? losses.reduce((s,r)=>s+r,0)/losses.length : 0;
  const grossProfit = wins.reduce((s,r)=>s+r,0);
  const grossLoss   = Math.abs(losses.reduce((s,r)=>s+r,0));
  const profitFactor = grossLoss>0 ? grossProfit/grossLoss : grossProfit>0?999:0;

  // Equity curve: 10% position per trade (no overlapping compounding)
  const POS_SIZE=0.10;
  let equity=100,peak=100,maxDD=0; const curve=[100];
  for(const r of rets){
    equity=Math.max(0,equity+equity*POS_SIZE*(r/100));
    if(equity>peak) peak=equity;
    const dd=(peak-equity)/peak*100; if(dd>maxDD) maxDD=dd; curve.push(equity);
  }
  // Total return = arithmetic average of individual trade returns
  const totalReturn=rets.length>0?rets.reduce((s,r)=>s+r,0)/rets.length:0;
  let gEq=100; const gCurve=[100];
  for(const r of grossRets){
    gEq=Math.max(0,gEq+gEq*POS_SIZE*(r/100)); gCurve.push(gEq);
  }
  const grossReturn=grossRets.length>0?grossRets.reduce((s,r)=>s+r,0)/grossRets.length:0;

  const mean=rets.reduce((s,r)=>s+r,0)/n;
  const variance=rets.reduce((s,r)=>s+(r-mean)**2,0)/n;
  const std=Math.sqrt(variance)||0.0001;
  const sharpe=mean/std*Math.sqrt(252/30);
  const downDev=Math.sqrt(losses.reduce((s,r)=>s+r**2,0)/(losses.length||1))||0.0001;
  const sortino=mean/downDev*Math.sqrt(252/30);
  const annualisedRet=mean*(252/30);
  const calmar=maxDD>0?annualisedRet/maxDD:annualisedRet>0?999:0;

  return {
    winRate,lossRate,avgWin,avgLoss,profitFactor,
    maxDrawdown:maxDD,sharpe,sortino,calmar,
    totalReturn,grossReturn,grossProfit,grossLoss,
    wins:wins.length,losses:losses.length,
    equityCurve:curve,totalCostPct,
  };
}

// ─── FIX 4: Temporal leak / cheat detection guard ────────────────────────────
// Throws a descriptive error if any test row date is <= any training row date,
// or if the warm-up period leaks into the test window.
const BACKTEST_WARMUP = 50;

function temporalLeakCheck(rows, trainEnd, testStart, testEnd, fold) {
  if(!rows || rows.length < 2) return;

  // 1. Verify rows are sorted ascending by date
  for(let i=1; i<rows.length; i++){
    if(rows[i].date && rows[i-1].date && rows[i].date < rows[i-1].date){
      throw new Error(
        `BACKTEST INTEGRITY VIOLATION (fold ${fold}): rows not sorted ascending. ` +
        `Row ${i} date="${rows[i].date}" before row ${i-1} date="${rows[i-1].date}". ` +
        `Sort your CSV oldest-first.`
      );
    }
  }

  // 2. Verify warm-up rows never appear in the test window
  if(testStart < BACKTEST_WARMUP){
    throw new Error(
      `BACKTEST INTEGRITY VIOLATION (fold ${fold}): test starts at row ${testStart}, ` +
      `inside the warm-up period (first ${BACKTEST_WARMUP} rows). ` +
      `Warm-up rows must never be used for testing.`
    );
  }

  // 3. Verify last train date < first test date (no date overlap)
  const lastTrainDate = rows[trainEnd - 1]?.date;
  const firstTestDate = rows[testStart]?.date;
  if(lastTrainDate && firstTestDate && firstTestDate <= lastTrainDate){
    throw new Error(
      `BACKTEST INTEGRITY VIOLATION (fold ${fold}): first test date (${firstTestDate}) ` +
      `is not strictly after last train date (${lastTrainDate}). ` +
      `Future data is leaking into training — results would be invalid.`
    );
  }
}

// ─── WALK-FORWARD BACKTEST — with benchmarks, stratified splits, Wilson CI ────
function walkForwardBacktest(rows, features, horizon=30, folds=5, stockName="", showNet=true) {
  const results=[];
  const minPerFold=40;
  const usableFolds=Math.min(folds,Math.max(1,Math.floor((rows.length-horizon-50)/minPerFold)));
  if(usableFolds<1) return null;

  const spreadCost = EXPERT_BASE[stockName]?.spread ?? 0;
  const warmup=Math.min(50,Math.floor(rows.length*0.15));
  const testBand=Math.floor((rows.length-warmup)/(usableFolds+1));
  const allTrades=[],allActuals=[],allPreds=[],allProbs=[];

  // Benchmark accumulators
  let bRandCorrect=0,bMajCorrect=0,bEmaCorrect=0,bTotal=0;

  for(let fold=0;fold<usableFolds;fold++){
    const trainEnd=warmup+(fold+1)*testBand;
    const testStart=trainEnd; // FIX 4: explicit name for clarity in leak check
    const testEnd=Math.min(trainEnd+testBand,rows.length-horizon);
    if(trainEnd>=rows.length-horizon||testEnd<=trainEnd) continue;

    // FIX 4: Temporal integrity check — catch cheating before computing anything
    try {
      temporalLeakCheck(rows, trainEnd, testStart, testEnd, fold);
    } catch(leakErr) {
      console.error('[InvestIQ Backtest Guard]', leakErr.message);
      results.push({
        fold, accuracy:0, stratRet:0, buyHold:0, testSize:0, trainSize:0,
        metrics:null, upAcc:null, flatAcc:null, downAcc:null,
        _leakDetected:true, _leakMsg:leakErr.message,
      });
      continue;
    }

    // ROLLING WINDOW: train only on the most recent rows before this fold
    // Prevents the expanding-window problem where old crisis data confuses newer folds
    // Window = min(2 years of data, available rows) — keeps training in same regime as test
    // 750 rows ~ 3 years — enough to capture one full bull+bear cycle
    // Smaller windows create too-small training sets that overfit to noise
    const ROLLING_WINDOW = Math.min(750, trainEnd - warmup);
    const rollingStart = Math.max(warmup, trainEnd - ROLLING_WINDOW);

    // Auto-calibrate deadband using only rolling window rows
    const foldAutoBand = calibrateDeadband(rows.slice(rollingStart, trainEnd), horizon, 0.30);
    const foldBand = Math.max(0.5, foldAutoBand);

    // Detect regime at start and end of training window
    // If regime flipped WITHIN the rolling window, flag this fold as potentially unreliable
    const foldCloses = rows.slice(rollingStart, trainEnd).map(r=>r.close).filter(Boolean);
    const foldRegimeFlip = foldCloses.length >= 60 ? (() => {
      const k20 = 2/(20+1), k60 = 2/(Math.min(60,foldCloses.length)+1);
      let e20=foldCloses[0], e60=foldCloses[0];
      const ema20=foldCloses.map(p=>{e20=p*k20+e20*(1-k20);return e20;});
      const ema60=foldCloses.map(p=>{e60=p*k60+e60*(1-k60);return e60;});
      const startTrend = ema20[0]>ema60[0]?"UP":"DOWN";
      const endTrend   = ema20[ema20.length-1]>ema60[ema60.length-1]?"UP":"DOWN";
      return startTrend !== endTrend;
    })() : false;

    // Build training set from rolling window only
    const allX=[],allY3=[];
    for(let i=rollingStart;i<trainEnd-horizon;i++){
      if(rows[i]?._boundary||rows[i+horizon]?._boundary) continue;
      const f=fv(features[i]); if(f.some(v=>!isFinite(v))) continue;
      const ret=(rows[i+horizon].close-rows[i].close)/rows[i].close*100;
      allX.push(f);
      allY3.push(ret > foldBand ? 2 : ret < -foldBand ? 0 : 1);
    }
    if(allX.length<20) continue;

    const norm=new Normaliser(); norm.fit(allX);
    const Xn=norm.transform(allX);
    const foldHp=adaptiveHyperparams(allX.length);

    // prepareBalancedBinary: excludes FLAT rows from classifier training
    const foldPrep=prepareBalancedBinary(Xn,allY3);
    const majClass=allY3.filter(v=>v===2).length>=allY3.filter(v=>v===0).length?2:0;

    const clf_up  =new LogReg({lr:0.05,epochs:foldHp.epochs,l2:foldHp.l2}); clf_up.fit(foldPrep.XUp,foldPrep.yUp,foldPrep.cwUp);
    const clf_down=new LogReg({lr:0.05,epochs:foldHp.epochs,l2:foldHp.l2}); clf_down.fit(foldPrep.XDown,foldPrep.yDown,foldPrep.cwDown);
    const gbdt_up  =new GBDT({nTrees:foldHp.nTrees,lr:0.08,mode:"classifier"}); gbdt_up.fit(foldPrep.XUp,foldPrep.yUp);
    const gbdt_down=new GBDT({nTrees:foldHp.nTrees,lr:0.08,mode:"classifier"}); gbdt_down.fit(foldPrep.XDown,foldPrep.yDown);

    // EMA crossover signal
    const e9arr=TA.ema(rows.map(r=>r.close),9);
    const e21arr=TA.ema(rows.map(r=>r.close),21);

    // Quick LR accuracy on sample of training rows to detect degenerate state
    let _lrc=0,_lrn=0;
    const _lrSample=Math.min(allX.length,150);
    for(let _i=0;_i<_lrSample;_i++){
      const _xn=norm.transform([allX[_i]])[0];
      const _p=clf_up.predict(_xn)>0.55?2:clf_down.predict(_xn)>0.55?0:1;
      if(_p===allY3[_i]) _lrc++;
      _lrn++;
    }
    const foldLrAcc=_lrn>0?_lrc/_lrn:0.5;

    let correct=0,total=0;
    // Per-class accuracy tracking
    let upCorrect=0,upTotal=0,flatCorrect=0,flatTotal=0,downCorrect=0,downTotal=0;
    const foldTrades=[];
    for(let i=trainEnd;i<testEnd;i++){
      if(rows[i]?._boundary||rows[i+horizon]?._boundary) continue;
      const f=fv(features[i]); if(f.some(v=>!isFinite(v))) continue;
      const xn=norm.transform([f])[0];

      // U4: use ensemble probability with adaptive threshold
      const probUp  =ensembleProb(clf_up,  gbdt_up,  xn, null, foldLrAcc);
      const probDown=ensembleProb(clf_down, gbdt_down, xn, null, foldLrAcc);
      const foldFlatPct=allY3.filter(v=>v===1).length/(allY3.length||1);
      const predThreshold=0.55+Math.min(0.08,Math.max(0,(foldFlatPct-0.25)*0.2));
      const pred = probUp>predThreshold?2:probDown>predThreshold?0:1;

      const ret=(rows[i+horizon].close-rows[i].close)/rows[i].close*100;
      // Use the SAME band as training — do NOT use labelDirection (which uses global default band)
      // Mismatch between training band and test band caused 100% BT accuracy (false!)
      const actual = ret > foldBand ? 2 : ret < -foldBand ? 0 : 1;

      if(pred===actual) correct++;
      total++;
      // Track per-class accuracy
      if(actual===2){upTotal++;   if(pred===2) upCorrect++;}
      if(actual===1){flatTotal++; if(pred===1) flatCorrect++;}
      if(actual===0){downTotal++; if(pred===0) downCorrect++;}

      allActuals.push(actual===2?1:0); allPreds.push(pred===2?1:0); allProbs.push(probUp);
      if(pred===2) {
        foldTrades.push({ret,pred,actual:actual===2?1:0});
        allTrades.push({ret,pred:1,actual:actual===2?1:0});
      }

      // Benchmarks (binary UP vs not-UP)
      const actBin=actual===2?1:0;
      bRandCorrect+=(Math.random()>0.5?1:0)===actBin?1:0;
      bMajCorrect+=(majClass===2?1:0)===actBin?1:0;
      const emaPred=e9arr[i]&&e21arr[i]&&e9arr[i]>e21arr[i]?1:0;
      bEmaCorrect+=emaPred===actBin?1:0;
      bTotal++;
    }
    if(total===0) continue;
    // Equal-weight average return per UP trade (not additive sum or compound)
    const stratRet=foldTrades.length>0
      ? foldTrades.reduce((s,t)=>s+t.ret,0)/foldTrades.length
      : 0;
    const buyHold=(rows[testEnd-1]?.close-rows[trainEnd]?.close)/rows[trainEnd]?.close*100||0;
    const metrics=calcAdvancedMetrics(foldTrades,showNet?spreadCost:0);
    results.push({fold,accuracy:correct/total,stratRet,buyHold,testSize:total,trainSize:allX.length,
      regimeFlip:foldRegimeFlip,  // true if training window had internal regime flip
      metrics,
      upAcc:upTotal>0?upCorrect/upTotal:null,
      flatAcc:flatTotal>0?flatCorrect/flatTotal:null,
      downAcc:downTotal>0?downCorrect/downTotal:null});
  }
  if(!results.length) return null;

  // FIX 4: Collect any integrity violations detected across folds
  const leakViolations = results.filter(r=>r._leakDetected).map(r=>r._leakMsg);
  const cleanResults   = results.filter(r=>!r._leakDetected);
  if(!cleanResults.length && leakViolations.length) {
    // All folds violated — return a sentinel so the UI can warn the user
    return {
      folds:results, avgAccuracy:0, avgStrategyReturn:0, avgBuyHold:0,
      horizon, aggregate:null, accuracyTrend:0,
      ci:{lo:0,hi:0,mid:0}, informationRatio:0, hasEdge:false,
      benchmarks:{random:0.5,majority:0.5,ema:0.5,buyHold:0.5},
      calibration:null, spreadCost, showNet,
      perClass:{up:null,flat:null,down:null},
      _allLeaked:true, _leakViolations:leakViolations,
    };
  }

  const useResults = cleanResults.length ? cleanResults : results;

  const n=allActuals.length||1;
  const modelCorrect=allPreds.filter((p,i)=>p===allActuals[i]).length;
  const ci=wilsonCI(modelCorrect,n);
  const randAcc=bRandCorrect/(bTotal||1);
  const majAcc=bMajCorrect/(bTotal||1);
  const emaAcc=bEmaCorrect/(bTotal||1);
  const modelAcc=modelCorrect/n;
  const bestBaseline=Math.max(randAcc,majAcc,emaAcc);
  const stderr=Math.sqrt(modelAcc*(1-modelAcc)/n)||0.001;
  const informationRatio=(modelAcc-bestBaseline)/stderr;
  const hasEdge=informationRatio>=1.0;
  const calibration=calcCalibration(allProbs,allActuals);

  const avgAcc  = Math.max(0,Math.min(1,useResults.reduce((s,r)=>s+r.accuracy,0)/useResults.length));
  const avgStrat = useResults.reduce((s,r)=>s+r.stratRet,0)/useResults.length;
  const avgBH    = useResults.reduce((s,r)=>s+r.buyHold,0)/useResults.length;
  const aggregate=calcAdvancedMetrics(allTrades,showNet?spreadCost:0);
  const accuracyTrend=useResults.length>=2?useResults[useResults.length-1].accuracy-useResults[0].accuracy:0;
  // Per-class accuracy averages
  const avgUpAcc  =useResults.filter(r=>r.upAcc!=null).reduce((s,r)=>s+r.upAcc,0)/(useResults.filter(r=>r.upAcc!=null).length||1);
  const avgFlatAcc=useResults.filter(r=>r.flatAcc!=null).reduce((s,r)=>s+r.flatAcc,0)/(useResults.filter(r=>r.flatAcc!=null).length||1);
  const avgDownAcc=useResults.filter(r=>r.downAcc!=null).reduce((s,r)=>s+r.downAcc,0)/(useResults.filter(r=>r.downAcc!=null).length||1);

  return {
    folds:results, avgAccuracy:avgAcc, avgStrategyReturn:avgStrat, avgBuyHold:avgBH,
    horizon, aggregate, accuracyTrend,
    ci, informationRatio, hasEdge,
    benchmarks:{random:randAcc,majority:majAcc,ema:emaAcc,buyHold:avgBH/100+0.5},
    calibration, spreadCost, showNet,
    perClass:{up:avgUpAcc,flat:avgFlatAcc,down:avgDownAcc},
    _leakViolations: leakViolations.length ? leakViolations : undefined,
  };
}
function calcCalibration(probs, actuals) {
  if(!probs||probs.length<20) return null;
  const bins=Array.from({length:10},(_,i)=>({lo:i*0.1,hi:(i+1)*0.1,preds:[],acts:[]}));
  probs.forEach((p,i)=>{
    const b=Math.min(9,Math.floor(p*10));
    bins[b].preds.push(p); bins[b].acts.push(actuals[i]);
  });
  const result=bins.map(b=>({
    midProb:(b.lo+b.hi)/2,
    count:b.acts.length,
    predictedProb:b.preds.length?b.preds.reduce((s,v)=>s+v,0)/b.preds.length:null,
    actualWinRate:b.acts.length?b.acts.reduce((s,v)=>s+v,0)/b.acts.length:null,
  })).filter(b=>b.count>0);

  // Flag poor calibration: any decile where |predicted - actual| > 0.2
  const poorlyCalibrated=result.some(b=>b.predictedProb!=null&&b.actualWinRate!=null&&Math.abs(b.predictedProb-b.actualWinRate)>0.2);
  return {bins:result,poorlyCalibrated};
}

// Features that are constant within quarters (CBK macro data) or are proxies
// for things the model shouldn't know — excluded from ablation study.
// These can still be used as features but shouldn't dominate the ablation ranking.
const ABLATION_EXCLUDE = new Set([
  "iCbkNpl",       // quarterly CBK figure — same value for 90+ days = data leak risk
  "macroCbkNorm",  // same quarterly source
  "macroRegime",   // derived from quarterly data
]);

// ─── FEATURE ABLATION STUDY ──────────────────────────────────────────────────
function runFeatureAblation(rows, features, horizon=30, stockName="") {
  if(!rows||rows.length<100||!features) return null;
  const keys=FEAT_KEYS;
  const warmup=50;
  const trainEnd=Math.floor(rows.length*0.7);
  const testEnd=rows.length-horizon;
  if(testEnd<=trainEnd+20) return null;

  const INTERACTION_KEYS=new Set(["iRsiRegime","iVolAtr","iMacdBb","iCbkNpl","iEmaCross","iStochObv"]);

  const buildXY=(dropIdx=-1)=>{
    const X=[],y=[];
    for(let i=warmup;i<trainEnd-horizon;i++){
      if(rows[i]?._boundary) continue;
      let f=fv(features[i]);
      if(dropIdx>=0){ f=f.slice(); f[dropIdx]=0; }
      if(f.some(v=>!isFinite(v))) continue;
      X.push(f);
      // U3: 3-class labels
      const ret=(rows[i+horizon].close-rows[i].close)/rows[i].close*100;
      y.push(labelDirection(ret,horizon)===2?1:0); // UP vs not-UP for ablation
    }
    return {X,y};
  };
  const evalAcc=(norm,clf,dropIdx=-1)=>{
    let correct=0,total=0;
    for(let i=trainEnd;i<testEnd;i++){
      if(rows[i]?._boundary) continue;
      let f=fv(features[i]);
      if(dropIdx>=0){ f=f.slice(); f[dropIdx]=0; }
      if(f.some(v=>!isFinite(v))) continue;
      const prob=clf.predict(norm.transform([f])[0]);
      const pred=prob>0.5?1:0;
      const ret=(rows[i+horizon].close-rows[i].close)/rows[i].close*100;
      const actual=labelDirection(ret,horizon)===2?1:0;
      if(pred===actual) correct++; total++;
    }
    return total>0?correct/total:0;
  };

  const {X:Xf,y:yf}=buildXY(-1);
  if(Xf.length<20) return null;
  const normFull=new Normaliser(); normFull.fit(Xf);
  const clfFull=new LogReg({lr:0.05,epochs:300,l2:0.002}); clfFull.fit(normFull.transform(Xf),yf);
  const fullAcc=evalAcc(normFull,clfFull,-1);

  const deltas=keys.map((key,dropIdx)=>{
    const {X,y}=buildXY(dropIdx);
    if(X.length<20) return {key,delta:0,accWithout:fullAcc,status:"insufficient",isInteraction:INTERACTION_KEYS.has(key)};
    const norm=new Normaliser(); norm.fit(X);
    const clf=new LogReg({lr:0.05,epochs:200,l2:0.002}); clf.fit(norm.transform(X),y);
    const accWithout=evalAcc(norm,clf,dropIdx);
    const delta=fullAcc-accWithout;
    // Mark constant/quarterly macro features — high delta here is a data leak warning
    const isMacroConstant=ABLATION_EXCLUDE.has(key);
    return {key,delta,accWithout,fullAcc,
      status: isMacroConstant ? "macro-constant" :
              delta>0.01?"helps":delta<-0.01?"hurts":"noise",
      isInteraction:INTERACTION_KEYS.has(key),
      isMacroConstant};
  });

  deltas.sort((a,b)=>b.delta-a.delta);
  return {fullAcc,deltas,horizon,stockName,ts:new Date().toISOString()};
}

// ─── TREND REGIME DETECTOR ───────────────────────────────────────────────────
// Detects if the trend direction has FLIPPED between training and test periods.
// A trend flip (bullish train → bearish test, or vice versa) means the model
// learned patterns that no longer apply. Different from OOD price check which
// only catches price-level breakouts.
function detectTrendRegimeFlip(rows, trainCutoffIdx) {
  if(!rows || rows.length < 60 || trainCutoffIdx < 40) return null;

  const closes = rows.map(r => r.close).filter(Boolean);
  if(closes.length < 60) return null;

  // Simple EMA function
  const computeEMA = (prices, period) => {
    const k = 2 / (period + 1);
    let e = prices[0];
    return prices.map(p => { e = p * k + e * (1 - k); return e; });
  };

  const ema20 = computeEMA(closes, 20);
  const ema60 = computeEMA(closes, Math.min(60, Math.floor(closes.length * 0.4)));

  // Trend at end of training period
  const trainIdx = Math.min(trainCutoffIdx - 1, closes.length - 1);
  const testIdx  = closes.length - 1;

  const trainTrend = ema20[trainIdx] > ema60[trainIdx] ? 'UP' : 'DOWN';
  const testTrend  = ema20[testIdx]  > ema60[testIdx]  ? 'UP' : 'DOWN';
  const isFlipped  = trainTrend !== testTrend;

  // Measure severity: how much did the trend flip?
  const trainMomentum = (ema20[trainIdx] - ema60[trainIdx]) / ema60[trainIdx] * 100;
  const testMomentum  = (ema20[testIdx]  - ema60[testIdx])  / ema60[testIdx]  * 100;

  return {
    trainTrend, testTrend, isFlipped,
    trainMomentum: trainMomentum.toFixed(2),
    testMomentum:  testMomentum.toFixed(2),
  };
}

// ─── PRICE REGIME DETECTOR ───────────────────────────────────────────────────
// Detects if the stock is in a different price regime than the training period.
// A regime shift makes forward predictions unreliable — the model learned
// patterns at different price levels and may not generalise.
function detectPriceRegimeShift(rows, trainCutoffIdx) {
  if (!rows || rows.length < 20 || trainCutoffIdx < 10) return null;
  const trainRows = rows.slice(0, trainCutoffIdx);
  const testRows  = rows.slice(trainCutoffIdx);
  if (testRows.length < 5) return null;

  const median = arr => {
    const s = [...arr].sort((a,b)=>a-b);
    const m = Math.floor(s.length/2);
    return s.length % 2 ? s[m] : (s[m-1]+s[m])/2;
  };

  const trainPrices = trainRows.map(r=>r.close).filter(Boolean);
  const testPrices  = testRows.map(r=>r.close).filter(Boolean);
  const trainMedian = median(trainPrices);
  const testMedian  = median(testPrices);
  const trainStd    = Math.sqrt(trainPrices.reduce((s,p)=>s+(p-trainMedian)**2,0)/trainPrices.length);
  const shift       = (testMedian - trainMedian) / (trainStd || trainMedian);

  // Volatility regime: is test period significantly more/less volatile?
  const trainVol = trainStd / trainMedian;
  const testStd  = Math.sqrt(testPrices.reduce((s,p)=>s+(p-testMedian)**2,0)/testPrices.length);
  const testVol  = testStd / testMedian;
  const volShift = testVol / (trainVol || 0.01);

  return {
    trainMedian: trainMedian.toFixed(2),
    testMedian:  testMedian.toFixed(2),
    shiftSigmas: shift.toFixed(2),  // how many std devs the median shifted
    volShift:    volShift.toFixed(2), // ratio of test vol to train vol
    isRegimeShift: Math.abs(shift) > 2.0,  // >2σ price level shift
    isVolShift:    volShift > 2.5 || volShift < 0.4, // dramatically different volatility
  };
}

// ─── REGIME STRESS TEST ──────────────────────────────────────────────────────
function regimeStressTest(rows, features, horizon=30, stockName="") {
  if(!rows||rows.length<100||!features) return null;
  // 2c: Use live macro snapshot for inflation, usd_kes, gdp_growth instead of hardcoded values
  const liveMacro = getMacroSnapshot();
  const regimeRows={tight:[],expansionary:[],neutral:[],stagflation:[],inflationary:[],currency_stress:[]};
  rows.forEach((r,i)=>{
    const cbk=getCbkRateOnDate(r.date);
    // Use live macro for non-CBK fields (best available without per-row historical macro)
    const macro={cbk_rate:cbk,inflation:liveMacro.inflation,usd_kes:liveMacro.usd_kes,gdp_growth:liveMacro.gdp_growth};
    const regime=detectRegime(macro)||"neutral";
    if(regimeRows[regime]!==undefined) regimeRows[regime].push(i);
    else regimeRows["neutral"].push(i);
  });

  const results={};
  for(const [regime,indices] of Object.entries(regimeRows)){
    if(indices.length<30) continue;
    const rRows=indices.map(i=>rows[i]);
    const rFeats=indices.map(i=>features[i]);
    const bt=walkForwardBacktest(rRows,rFeats,horizon,3,stockName,false);
    if(bt) results[regime]={accuracy:bt.avgAccuracy,stratRet:bt.avgStrategyReturn,n:indices.length,folds:bt.folds.length};
  }
  if(Object.keys(results).length<2) return {results,regimeDependent:false,note:"Insufficient data per regime"};

  const accs=Object.values(results).map(r=>r.accuracy);
  const maxAcc=Math.max(...accs), minAcc=Math.min(...accs);
  const regimeDependent=(maxAcc-minAcc)>0.15;

  return {results,regimeDependent,spread:maxAcc-minAcc,bestRegime:Object.entries(results).sort((a,b)=>b[1].accuracy-a[1].accuracy)[0]?.[0],worstRegime:Object.entries(results).sort((a,b)=>a[1].accuracy-b[1].accuracy)[0]?.[0]};
}


// ─── PATTERN MATCHER ─────────────────────────────────────────────────────────
function cosSim(a,b) {
  let dot=0,nA=0,nB=0;
  for(let i=0;i<a.length;i++){dot+=a[i]*b[i];nA+=a[i]**2;nB+=b[i]**2;}
  return nA&&nB?dot/(Math.sqrt(nA)*Math.sqrt(nB)):0;
}

// BUG FIX 2e: Normaliser now fitted ONLY on historical candidate vectors.
// Previously the query at targetIdx was included in the fit, causing it to
// influence its own z-scores and distort cosine similarity.
// Fix: fit on candidates (i < targetIdx - horizon - 1), then transform both
// candidates and query using those statistics only.
function findPatterns(features, rows, targetIdx, horizon, topN=8) {
  const vecs=features.map(fv);
  // Collect historical candidate indices (hard stop: must be at least horizon+1 before targetIdx)
  const candIdx=[];
  for(let i=50;i<targetIdx-horizon-1;i++){
    if(rows[i]?._boundary||rows[i+horizon]?._boundary) continue;
    candIdx.push(i);
  }
  if(candIdx.length < 5) return [];
  // Fit normaliser ONLY on historical candidates (not the query)
  const norm=new Normaliser();
  norm.fit(candIdx.map(i=>vecs[i]));
  // Transform candidates and query separately using historical statistics
  const nCands=norm.transform(candIdx.map(i=>vecs[i]));
  const q=norm.transform([vecs[targetIdx]])[0];
  const cands=[];
  for(let ci=0;ci<candIdx.length;ci++){
    const i=candIdx[ci];
    const sim=cosSim(q,nCands[ci]);
    if(sim>0.7){
      const ret=((rows[i+horizon].close-rows[i].close)/rows[i].close)*100;
      cands.push({idx:i,date:rows[i].date,sim,futureReturn:ret,price:rows[i].close});
    }
  }
  cands.sort((a,b)=>b.sim-a.sim);
  return cands.slice(0,topN);
}

// ─── RISK SCORE ───────────────────────────────────────────────────────────────
function calcRisk(f, expert) {
  let score=0; const flags=[];
  if(f.rsi14>75){score+=2;flags.push(`RSI overbought (${f.rsi14?.toFixed(0)})`);}
  if(f.rsi14<30){score+=1;flags.push(`RSI oversold (${f.rsi14?.toFixed(0)})`);}
  if(f.bbPct>0.95){score+=2;flags.push("Price at upper Bollinger Band");}
  if(f.bbPct<0.05){score+=1;flags.push("Price at lower Bollinger Band");}
  if(f.atrPct>4){score+=2;flags.push(`High volatility ATR ${f.atrPct?.toFixed(1)}%`);}
  if(f.vSpike>3){score+=1;flags.push(`Volume spike ${f.vSpike?.toFixed(1)}x avg`);}
  if(f.e50v200<0&&f.e21v50<0){score+=2;flags.push("Death cross: EMA50 < EMA200");}
  if(f.macdAbove===-1&&f.macdHist<0){score+=1;flags.push("MACD bearish crossover");}
  if(expert?.npl>15){score+=2;flags.push(`NPL danger zone: ${expert.npl}%`);}
  if(expert?.liq===3&&expert?.spread>2){score+=1;flags.push(`Liquidity trap: ${expert.spread}% spread`);}
  return {score:Math.min(10,score),flags,level:score>=6?"HIGH":score>=3?"MEDIUM":"LOW"};
}

// ─── GENERATE PREDICTION ─────────────────────────────────────────────────────
function generatePrediction(stockData) {
  const {rows,features,models,name}=stockData;
  if(!rows||rows.length<60||!features) return null;
  const lastIdx=rows.length-1; const f=features[lastIdx]; const expert=EXPERT_BASE[name];
  const p30=findPatterns(features,rows,lastIdx,30);
  const p60=findPatterns(features,rows,lastIdx,60);
  const p90=findPatterns(features,rows,lastIdx,90);
  const patTgt=(ps)=>{if(!ps.length)return null;const w=ps.reduce((s,p)=>s+p.futureReturn*p.sim,0),t=ps.reduce((s,p)=>s+p.sim,0);return t>0?w/t:null;};
  const pt30=patTgt(p30),pt60=patTgt(p60),pt90=patTgt(p90);
  let modelProb=0.5,modelRet30=pt30;
  if(models?.m30) {
    const xn=models.m30.norm.transform([fv(f)])[0];
    // Use ensemble if GBDT available, else fall back to clf_up or clf
    const probUp=ensembleProb(models.m30.clf_up||models.m30.clf, models.m30.gbdt_up, xn, p30);
    modelProb=probUp;
    const mr=models.m30.reg.predict(xn);
    modelRet30=pt30!==null?(mr*0.5+pt30*0.5):mr;
  }
  const cur=rows[lastIdx].close;
  const mkT=(ret)=>ret!==null?cur*(1+ret/100):null;
  let conf=50;
  if(models?.backtest) conf=models.backtest.avgAccuracy*100;
  const pa=p30.filter(p=>modelProb>0.5?p.futureReturn>0:p.futureReturn<0).length/(p30.length||1);
  conf=Math.round(Math.max(0,Math.min(99,conf*0.6+pa*100*0.4)));
  const signal=modelProb>0.62?"BUY":modelProb<0.38?"SELL":"HOLD";
  const last20Vols=rows.slice(-20).map(r=>r.volume);
  const avgVol20=last20Vols.reduce((s,v)=>s+v,0)/last20Vols.length;
  const lowLiquidityWarning=avgVol20<50000&&expert?.liq===3;
  const dividendCapture=checkDividendCapture(name||"");
  return {
    signal,confidence:conf,modelProb,
    target30:mkT(modelRet30),target60:mkT(pt60),target90:mkT(pt90),
    pctTarget30:modelRet30,pctTarget60:pt60,pctTarget90:pt90,
    patterns30:p30,patterns60:p60,patterns90:p90,
    riskScore:calcRisk(f,expert),currentFeatures:f,
    modelAccuracy:models?.backtest?.avgAccuracy??null,
    lowLiquidityWarning, dividendCapture,
    regimeShift: rows.length > 20 ? detectPriceRegimeShift(rows, Math.floor(rows.length * 0.8)) : null,
  };
}

const STOCK_KEY=(n)=>`iq_stock_${n.replace(/\s+/g,"_")}`;
function loadStockData(name, stockDataMap={}) {
  try {
    const raw=db.load(STOCK_KEY(name));
    if(!raw||!Array.isArray(raw)||raw.length<2) return null;
    // Sanitise: drop rows with invalid dates or non-positive closes
    const clean = sanitiseRows(raw);
    if(clean.length < 2) return null;
    const features=buildFeaturesForStock(clean,name,null,null,stockDataMap);
    return {name,rows:clean,features};
  } catch(e) {
    console.warn(`loadStockData failed for ${name}:`,e);
    return null;
  }
}
function saveStockData(name,rows){
  // 5c: write guard — viewers cannot save stock data
  if(!hasAdminRole()) { console.warn("saveStockData blocked — viewer role"); return false; }
  return db.save(STOCK_KEY(name),rows);
}
function listStocks(){return db.keys("iq_stock_").map(k=>k.replace("iq_stock_","").replace(/_/g," "));}

// Stock boundary safety — when combining multi-stock CSVs, never let training
// windows span two different stocks (date resets or ticker column changes)
function enforceStockBoundaries(rows) {
  const safe=[];
  for(let i=0;i<rows.length;i++){
    if(i>0){
      const prev=rows[i-1]; const cur=rows[i];
      // Detect boundary: date goes backwards or stays same
      if(cur.date<=prev.date){
        // Mark boundary so downstream training skips this window
        safe.push({...cur,_boundary:true});
        continue;
      }
    }
    safe.push({...rows[i],_boundary:false});
  }
  return safe;
}

// =============================================================================
// ─── MACRO ENGINE (from macro.ts) ────────────────────────────────────────────
// =============================================================================

const MACRO_DEFAULTS = { cbk_rate:13, inflation:4.5, usd_kes:129.5, gdp_growth:5.0 };

function detectRegime(macro) {
  const {cbk_rate=13,inflation=4.5,usd_kes=129.5,gdp_growth=5.0} = macro||{};
  if(inflation>7&&gdp_growth<3)        return "stagflation";
  if(cbk_rate>13&&inflation>6)         return "tight";
  if(usd_kes>135)                      return "currency_stress";
  if(inflation>9)                      return "inflationary";
  if(cbk_rate<10&&gdp_growth>5)        return "expansionary";
  return "neutral";
}

const REGIME_META = {
  neutral:          { label:"🟡 Neutral",        color:"#eab308", advice:"Balanced allocation. Monitor CBK.", overweight:["equities","bonds","tbills"],  underweight:[] },
  tight:            { label:"🔴 Tight Money",    color:"#ef4444", advice:"Favour T-Bills, cash. Avoid banks, REITs.", overweight:["tbills","cash","ifb"], underweight:["banking","reit"] },
  expansionary:     { label:"🟢 Expansionary",   color:"#22c55e", advice:"Banks and REITs benefit. Good equity entry.", overweight:["banking","reit","equities"], underweight:["cash"] },
  inflationary:     { label:"🔴 Inflationary",   color:"#ef4444", advice:"Real yields erode. Favour equities, hard assets.", overweight:["equities","crypto"], underweight:["long_bonds"] },
  currency_stress:  { label:"🟡 KES Stress",     color:"#eab308", advice:"USD assets gain in KES terms. Watch imported inflation.", overweight:["foreign_stocks","crypto"], underweight:["kes_bonds"] },
  stagflation:      { label:"🔴 Stagflation",    color:"#ef4444", advice:"Very defensive — T-Bills, USD, IFBs.", overweight:["tbills","ifb","foreign_stocks"], underweight:["banking","reit","growth"] },
};

const MACRO_SCENARIOS_LIST = [
  { id:"cbk_hike",        label:"CBK Raises Rates +2%",    impact:"bearish", cbk_delta:2,   inf_delta:0,   fx_delta:0,   assets:["KCB Group","Equity Bank","Co-op Bank","Acorn REIT","Infra Bond (IFB)"], note:"Bank NPLs rise. REIT cap rates expand. Existing bonds lose mark-to-market value." },
  { id:"cbk_cut",         label:"CBK Cuts Rates -2%",       impact:"bullish", cbk_delta:-2,  inf_delta:0,   fx_delta:0,   assets:["KCB Group","Equity Bank","Acorn REIT","Infra Bond (IFB)"],             note:"Banks benefit. REITs re-rate higher. Fixed-income bonds appreciate." },
  { id:"kes_weak",        label:"KES Weakens +15 pts",      impact:"mixed",   cbk_delta:0,   inf_delta:1.5, fx_delta:15,  assets:["Bitcoin","NVIDIA","Apple","Microsoft"],                                  note:"USD-denominated assets gain in KES terms. Imported inflation rises." },
  { id:"inflation_spike", label:"Inflation Spikes >10%",    impact:"bearish", cbk_delta:1,   inf_delta:5,   fx_delta:0,   assets:["T-Bill 91-day","T-Bill 364-day","Infra Bond (IFB)"],                    note:"Real T-Bill yields turn negative. IFB 18.2% becomes marginal in real terms." },
  { id:"recession",       label:"Regional Recession",       impact:"bearish", cbk_delta:0,   inf_delta:2,   fx_delta:8,   assets:["KCB Group","Equity Bank","EABL","Safaricom"],                            note:"Loan defaults surge. Consumer spending contracts. Dividend cuts probable." },
  { id:"ai_boom",         label:"Global AI Boom",           impact:"bullish", cbk_delta:0,   inf_delta:0,   fx_delta:-5,  assets:["NVIDIA","Apple","Microsoft","Bitcoin"],                                   note:"Tech multiples expand. Capital inflows strengthen KES." },
];

function macroAdjustments(regime, liquidity, spread, sentiment) {
  const rp = ["tight","inflationary","stagflation"].includes(regime) ? 8 : 0;
  const sb = sentiment==="bullish"?5:sentiment==="bearish"?-10:0;
  const lp = liquidity===3?10:liquidity===2?3:0;
  const sp = spread>2?8:spread>1?3:0;
  return { regimePenalty:rp, sentimentBonus:sb, liqPenalty:lp, spreadPenalty:sp, totalAdjustment:-rp+sb-lp-sp };
}

function realYield(nominal, inflation, taxRate=0.15) {
  const afterTax = nominal*(1-taxRate);
  return { nominal, afterTax:+afterTax.toFixed(2), real:+(nominal-inflation).toFixed(2), realAfterTax:+(afterTax-inflation).toFixed(2) };
}

function simulateScenario(sc, baseline) {
  const sim = { ...baseline, cbk_rate:(baseline.cbk_rate||13)+sc.cbk_delta, inflation:(baseline.inflation||4.5)+sc.inf_delta, usd_kes:(baseline.usd_kes||129.5)+sc.fx_delta };
  const fromR=detectRegime(baseline), toR=detectRegime(sim);
  return { scenario:sc, baseline, simulated:sim, regimeShift:fromR!==toR?{from:fromR,to:toR,meta:REGIME_META[toR]}:null };
}

// =============================================================================
// ─── TAX ENGINE (from tax.ts) ─────────────────────────────────────────────────
// =============================================================================

const TAX_RULES = {
  dividend:       { rate:0.15,  label:"15% WHT on dividends",         taxFree:false, notes:"Applies to all NSE dividends for residents." },
  tbill:          { rate:0.15,  label:"15% WHT on T-Bill / T-Bond",   taxFree:false, notes:"Deducted at source by CBK." },
  ifb:            { rate:0.00,  label:"0% — IFB is tax-exempt",       taxFree:true,  notes:"Exempt under s.7(1)(f) Income Tax Act." },
  crypto:         { rate:0.03,  label:"3% Digital Asset Tax (2023)",  taxFree:false, notes:"On gross transaction value, not profit." },
  reit:           { rate:0.15,  label:"15% WHT on REIT distributions",taxFree:false, notes:"Applies to I-REITs and D-REITs on NSE." },
  foreign_stock:  { rate:0.00,  label:"0% Kenyan WHT on foreign stocks", taxFree:true, notes:"No Kenyan WHT at source on foreign equities." },
  savings_account:{ rate:0.15,  label:"15% WHT on bank interest",     taxFree:false, notes:"Applies above KES 3,000/year." },
  mmf:            { rate:0.15,  label:"15% WHT on MMF income",        taxFree:false, notes:"Treated as interest income." },
};

const ASSET_TAX_MAP = {
  "KCB Group":"dividend","Equity Bank":"dividend","Safaricom":"dividend","EABL":"dividend",
  "Co-op Bank":"dividend","BAT Kenya":"dividend","Stanbic Kenya":"dividend",
  "Infra Bond (IFB)":"ifb","T-Bill 91-day":"tbill","T-Bill 364-day":"tbill",
  "Bitcoin":"crypto","Ethereum":"crypto","BNB":"crypto","Solana":"crypto","XRP":"crypto",
  "Apple":"foreign_stock","Microsoft":"foreign_stock","Amazon":"foreign_stock",
  "Tesla":"foreign_stock","NVIDIA":"foreign_stock","Alphabet":"foreign_stock",
  "Acorn REIT":"reit","Fahari REIT":"reit","MMF":"mmf","Savings Account":"savings_account",
};

function calcNetYield(assetName, grossYield, taxCat) {
  const cat  = taxCat || ASSET_TAX_MAP[assetName] || "dividend";
  const rule = TAX_RULES[cat];
  const taxPaid  = +(grossYield*rule.rate).toFixed(4);
  const netYield = +(grossYield*(1-rule.rate)).toFixed(4);
  return { assetName, taxCategory:cat, rule, grossYield:+grossYield.toFixed(4), taxPaid, netYield, taxFree:rule.taxFree, netYieldDecimal:netYield/100 };
}

function projectIncome(assetName, grossYield, amount, taxCat) {
  const bd = calcNetYield(assetName, grossYield, taxCat);
  const ann = +(amount*bd.netYieldDecimal).toFixed(2);
  return { breakdown:bd, investmentAmount:amount, annualIncome:ann, monthlyIncome:+(ann/12).toFixed(2), fiveYearValue:+(amount*Math.pow(1+bd.netYieldDecimal,5)).toFixed(2) };
}

function compareAfterTax(assets) {
  const bds = assets.map(a=>calcNetYield(a.name,a.grossYield,a.taxCat)).sort((a,b)=>b.netYield-a.netYield);
  const tBill364Net = calcNetYield("T-Bill 364-day",16.4).netYield;
  return { assets:bds, best:bds[0], worst:bds[bds.length-1], taxFree:bds.filter(b=>b.taxFree), bpVsTBill:+((bds[0].netYield-tBill364Net)*100).toFixed(1) };
}

function ifbArbitrage(ifbGross, tbillGross) {
  const ifbNet  = calcNetYield("Infra Bond (IFB)",ifbGross,"ifb").netYield;
  const tbNet   = calcNetYield("T-Bill 364-day",tbillGross,"tbill").netYield;
  const bp      = +((ifbNet-tbNet)*100).toFixed(0);
  return { ifbNet, tbillNet:tbNet, bpAdvantage:bp, description:`IFB earns ${ifbNet.toFixed(2)}% net vs T-Bill ${tbNet.toFixed(2)}% net — a ${bp}bps after-tax advantage.` };
}

// =============================================================================
// ─── EXPERT GATE ENGINE (from expert.ts) ─────────────────────────────────────
// =============================================================================

function calcBaseOdds(profile) {
  let s=60;
  if(profile.npl>15)       s-=25; else if(profile.npl>10) s-=10;
  if(profile.divYield>15)  s+=22; else if(profile.divYield>8) s+=12; else if(profile.divYield>4) s+=6;
  if(profile.taxFree)      s+=15;
  if(profile.liq===3)      s-=12;
  if(profile.spread>2)     s-=8;
  return Math.min(100,Math.max(10,s));
}

function confidenceGate(assetName, macro, sentiment="neutral", profile) {
  const m = profile||EXPERT_BASE[assetName]; if(!m) return null;
  const regime = detectRegime(macro||MACRO_DEFAULTS);
  const adj    = macroAdjustments(regime,m.liq,m.spread,sentiment);
  const base   = calcBaseOdds(m);
  const conds  = {
    safeNPL:      !m.npl||m.npl<15,
    goodYield:    (m.divYield||0)>5,
    liquid:       m.liq<=2,
    positiveSent: sentiment!=="bearish",
    stableRegime: regime==="neutral"||regime==="expansionary",
    lowSpread:    (m.spread||0)<1,
  };
  const pass = Object.values(conds).filter(Boolean).length;
  const level = pass>=5?"HIGH":pass>=3?"MEDIUM":"LOW";
  const odds  = Math.min(100,Math.max(5,base+adj.totalAdjustment));
  return { assetName, odds, level, conditions:conds, regimePenalty:adj.regimePenalty, sentimentBonus:adj.sentimentBonus, liqPenalty:adj.liqPenalty, spreadPenalty:adj.spreadPenalty, regime, passCount:pass, base };
}

function rankAssets(macro, sentiment={}) {
  return Object.keys(EXPERT_BASE)
    .map(name=>{ try{ const g=confidenceGate(name,macro,sentiment[name]||"neutral"); return{assetName:name,odds:g.odds,level:g.level,advisory:EXPERT_BASE[name].advisory}; }catch{return null;} })
    .filter(Boolean).sort((a,b)=>b.odds-a.odds);
}

// =============================================================================
// ─── NPL ENGINE (from npl.ts) ────────────────────────────────────────────────
// =============================================================================

const INDUSTRY_NPL_AVG = 15.5;
const BANK_PROFILES = {
  "KCB Group":    { nplRatio:17.3, coverageRatio:62, profitTrend:-4.1, costOfRisk:3.8, loanGrowth:8.2,  fxExposure:false, tier:1 },
  "Equity Bank":  { nplRatio:12.2, coverageRatio:71, profitTrend:8.4,  costOfRisk:2.1, loanGrowth:14.5, fxExposure:true,  tier:1 },
  "Co-op Bank":   { nplRatio:14.1, coverageRatio:68, profitTrend:2.1,  costOfRisk:2.9, loanGrowth:5.8,  fxExposure:false, tier:1 },
  "Stanbic Kenya":{ nplRatio:8.4,  coverageRatio:78, profitTrend:6.2,  costOfRisk:1.4, loanGrowth:9.1,  fxExposure:true,  tier:2 },
};

function analyzeNPL(bankName, macro={}, profile) {
  const b = profile||BANK_PROFILES[bankName]; if(!b) return null;
  const usdKes=macro.usd_kes||129.5;
  const nplPressure=b.nplRatio/INDUSTRY_NPL_AVG;
  const fxStress=b.fxExposure&&usdKes>130?10:0;
  const expRisk=b.loanGrowth>12&&b.nplRatio>INDUSTRY_NPL_AVG?8:0;
  const covPenalty=Math.max(0,65-b.coverageRatio)*1.2;
  const raw=(b.nplRatio/INDUSTRY_NPL_AVG)*40+covPenalty+(-b.profitTrend)*2+b.costOfRisk*3+fxStress+expRisk;
  const riskScore=Math.max(0,Math.min(100,raw));
  const provImpact=Math.max(0,(b.nplRatio-INDUSTRY_NPL_AVG)*0.6);
  const zone=riskScore<40?"SAFE":riskScore<65?"WATCH":"HIGH RISK";
  const warnings=[];
  if(nplPressure>1.2) warnings.push({type:"credit",msg:`NPL ${((nplPressure-1)*100).toFixed(0)}% above sector avg`,sev:nplPressure>1.4?"high":"medium"});
  if(provImpact>3)    warnings.push({type:"profit",msg:`~${provImpact.toFixed(1)}% profits to provisions`,sev:provImpact>6?"high":"medium"});
  if(riskScore>70&&b.profitTrend<0) warnings.push({type:"dividend",msg:"Dividend at risk next reporting cycle",sev:"high"});
  if(b.loanGrowth>12&&b.nplRatio>INDUSTRY_NPL_AVG) warnings.push({type:"expansion",msg:"Aggressive loan growth amplifying NPL",sev:"medium"});
  if(fxStress>0) warnings.push({type:"fx",msg:"KES weakness stressing FX-exposed balance sheet",sev:"medium"});
  return { bankName, profile:b, riskScore:+riskScore.toFixed(1), zone, nplPressure:+nplPressure.toFixed(3), provImpact:+provImpact.toFixed(2), warnings, dividendAtRisk:riskScore>70, outlook:riskScore>70?"Earnings volatile. Dividend growth at risk.":riskScore>50?"Monitor NPL trajectory closely.":"Balance sheet healthy. Dividend sustainable." };
}

function analyzeSector(macro={}) {
  const analyses=Object.keys(BANK_PROFILES).map(n=>analyzeNPL(n,macro)).filter(Boolean).sort((a,b)=>b.riskScore-a.riskScore);
  const avgNPL=analyses.reduce((s,a)=>s+a.profile.nplRatio,0)/analyses.length;
  const hrCount=analyses.filter(a=>a.zone==="HIGH RISK").length;
  const systemic=hrCount>=3?"high":hrCount>=2?"elevated":avgNPL>INDUSTRY_NPL_AVG?"moderate":"low";
  return { averageNPL:+avgNPL.toFixed(2), worstBank:analyses[0]?.bankName, safestBank:analyses[analyses.length-1]?.bankName, systemicRisk:systemic, analyses };
}

// =============================================================================
// ─── KILL SWITCH ENGINE (from killswitch.ts) ─────────────────────────────────
// =============================================================================

const DEFAULT_LOSS_THRESHOLD = -10;
const DEFENSIVE_REGIMES = ["tight","stagflation","inflationary"];

function calcHoldingMetrics(holding, curPrice) {
  const cost=holding.qty*holding.buyPrice, val=holding.qty*curPrice, pnl=val-cost;
  const pct=cost>0?(pnl/cost)*100:0;
  let daysHeld; if(holding.openedAt){const ms=Date.now()-new Date(holding.openedAt).getTime();daysHeld=Math.floor(ms/86400000);}
  return { holding, currentPrice:curPrice, costBasis:+cost.toFixed(2), currentValue:+val.toFixed(2), unrealisedPnL:+pnl.toFixed(2), unrealisedPct:+pct.toFixed(2), daysHeld };
}

function evaluateHolding(state, lossThreshold=DEFAULT_LOSS_THRESHOLD) {
  const {holding,currentPrice,sentiment,confidence,currentNPL,baselineNPL,currentSpread}=state;
  const m=calcHoldingMetrics(holding,currentPrice);
  const alerts=[]; const now=new Date().toISOString();
  const base={holdingId:holding.id,assetName:holding.assetName,currentPct:m.unrealisedPct,triggeredAt:now};
  if(holding.stopLoss!==undefined&&currentPrice<=holding.stopLoss)
    alerts.push({...base,type:"STOP_LOSS_HIT",severity:"critical",message:`Price ${currentPrice} breached stop-loss ${holding.stopLoss}`,action:"EXIT"});
  if(holding.takeProfit!==undefined&&currentPrice>=holding.takeProfit)
    alerts.push({...base,type:"TAKE_PROFIT_HIT",severity:"info",message:`Price ${currentPrice} reached take-profit ${holding.takeProfit}`,action:"REDUCE"});
  const bearKill=Math.max(-5,lossThreshold/2);
  if(m.unrealisedPct<=bearKill&&sentiment==="bearish")
    alerts.push({...base,type:"BEARISH_SENTIMENT",severity:"critical",message:`${m.unrealisedPct.toFixed(1)}% loss + bearish sentiment — momentum against you`,action:"EXIT"});
  if(m.unrealisedPct<=lossThreshold&&sentiment!=="bearish")
    alerts.push({...base,type:"LOSS_THRESHOLD",severity:"warning",message:`Position down ${m.unrealisedPct.toFixed(1)}% — review thesis`,action:"WATCH"});
  if(confidence==="LOW"&&m.unrealisedPct<0)
    alerts.push({...base,type:"CONFIDENCE_DROP",severity:"warning",message:"Confidence gate rated LOW — fundamentals deteriorated since entry",action:"WATCH"});
  if(currentNPL!==undefined&&baselineNPL!==undefined){
    const d=currentNPL-baselineNPL;
    if(d>=3) alerts.push({...base,type:"NPL_DETERIORATION",severity:d>=5?"critical":"warning",message:`NPL +${d.toFixed(1)}pp since entry (${baselineNPL}%→${currentNPL}%). Dividend at risk.`,action:d>=5?"EXIT":"REDUCE"});
  }
  if(currentSpread!==undefined&&currentSpread>2)
    alerts.push({...base,type:"SPREAD_TRAP",severity:currentSpread>3?"critical":"warning",message:`Spread ${currentSpread}% — exit costs ${currentSpread.toFixed(1)}% of position`,action:"WATCH"});
  return alerts;
}

function suggestExitLevels(entryPrice, volatility, riskReward=2) {
  const dailyVol=volatility/Math.sqrt(252)/100;
  const riskPct=Math.min(15,+(dailyVol*2*100*5).toFixed(2));
  const rewardPct=+(riskPct*riskReward).toFixed(2);
  return { stopLoss:+(entryPrice*(1-riskPct/100)).toFixed(4), takeProfit:+(entryPrice*(1+rewardPct/100)).toFixed(4), riskPct, rewardPct };
}

function evaluatePortfolio(positions, macro, lossThreshold=DEFAULT_LOSS_THRESHOLD) {
  const regime=detectRegime(macro||MACRO_DEFAULTS);
  const now=new Date().toISOString();
  const holdAlerts=positions.flatMap(p=>evaluateHolding(p,lossThreshold));
  const portAlerts=[];
  if(DEFENSIVE_REGIMES.includes(regime))
    portAlerts.push({type:"REGIME_SHIFT",severity:"warning",message:`Regime "${regime}" — rotate to defensive assets (T-Bills, IFBs, cash)`,action:"Review banking and growth equity allocations",triggeredAt:now});
  const totalVal=positions.reduce((s,p)=>s+p.holding.qty*p.currentPrice,0);
  if(totalVal>0){
    for(const p of positions){
      const val=p.holding.qty*p.currentPrice, pct=val/totalVal*100;
      if(["BAT Kenya","Acorn REIT","Fahari REIT"].includes(p.holding.assetName)&&pct>15)
        portAlerts.push({type:"CONCENTRATION",severity:"warning",message:`${p.holding.assetName} is ${pct.toFixed(1)}% of portfolio — exceeds 15% illiquid limit`,action:"Reduce to below 15%",triggeredAt:now});
    }
  }
  const exitSet=new Set(holdAlerts.filter(a=>a.action==="EXIT").map(a=>a.assetName));
  const watchSet=new Set(holdAlerts.filter(a=>a.action==="WATCH"||a.action==="REDUCE").map(a=>a.assetName));
  const crit=holdAlerts.filter(a=>a.severity==="critical").length;
  const warn=holdAlerts.filter(a=>a.severity==="warning").length;
  const risk=crit>0?"red":warn>0||portAlerts.length>0?"amber":"green";
  return { holdingAlerts:holdAlerts, portfolioAlerts:portAlerts, positionsToExit:[...exitSet], positionsToWatch:[...watchSet].filter(n=>!exitSet.has(n)), overallRisk:risk, evaluatedAt:now };
}

// =============================================================================
// ─── TRAINING PIPELINE GUARDS ────────────────────────────────────────────────
// =============================================================================

const MIN_TRAIN_SAMPLES    = 150;  // Guard 1: minimum samples
const SMALL_DATASET_THRESH = 300;  // below this → use reduced feature set
const CONFIDENCE_NEUTRAL_BAND = 0.12; // Guard 4: |prob-0.5| < 0.12 → NEUTRAL

// Guard 2: top-8 features by variance (computed once from data, used for small datasets)
const TOP8_FEAT_KEYS = ["rsi14","pvE21","pvE50","macdAbove","bbPct","roc20","atrPct","e50v200"];

function fvFull(f)   { return FEAT_KEYS.map(k=>f[k]!=null&&isFinite(f[k])?f[k]:0); }
function fvReduced(f){ return TOP8_FEAT_KEYS.map(k=>f[k]!=null&&isFinite(f[k])?f[k]:0); }

// Guard 3: classify each row's regime volatility (stable/volatile) using ATR
function classifyRowRegime(f) {
  const vol = f.atrPct||0;
  const trend = f.e50v200||0;
  if(vol>3)              return "volatile";
  if(trend>0&&vol<1.5)   return "stable_bull";
  if(trend<0&&vol<1.5)   return "stable_bear";
  return "neutral";
}

// Guard 3: check if train and test periods span different regimes
function detectRegimeMismatch(trainFeatures, testFeatures) {
  const regime=(fs)=>{
    const atrs=fs.map(f=>f.atrPct||0).filter(v=>v>0);
    const avgAtr=atrs.length?atrs.reduce((s,v)=>s+v,0)/atrs.length:0;
    return avgAtr>3?"volatile":"stable";
  };
  const tr=regime(trainFeatures), te=regime(testFeatures);
  return { trainRegime:tr, testRegime:te, mismatch:tr!==te };
}

// Guard 5: ensemble — train separate models for stable and volatile regimes
function trainEnsembleModels(rows, features, horizon) {
  // Split rows into stable and volatile regimes
  const stableIdx=[], volatileIdx=[];
  for(let i=0;i<rows.length-horizon;i++){
    const r=classifyRowRegime(features[i]||{});
    if(r==="volatile"||r==="stable_bear") volatileIdx.push(i);
    else stableIdx.push(i);
  }
  const buildSubset=(indices)=>{
    if(indices.length<50) return null;
    const X=[],yDir=[],yRet=[];
    for(const i of indices){
      const f=fv(features[i]); if(f.some(v=>!isFinite(v))) continue;
      const ret=(rows[i+horizon].close-rows[i].close)/rows[i].close;
      X.push(f); yDir.push(labelDirection(ret*100,horizon)===2?1:0); yRet.push(ret*100);
    }
    if(X.length<30) return null;
    const norm=new Normaliser(); norm.fit(X); const Xn=norm.transform(X);
    const clf=new LogReg({lr:0.05,epochs:400,l2:0.002}); clf.fit(Xn,yDir);
    const reg=new LinReg(); reg.fit(Xn,yRet);
    return {clf,reg,norm,size:X.length};
  };
  return { stable:buildSubset(stableIdx), volatile:buildSubset(volatileIdx), stableCount:stableIdx.length, volatileCount:volatileIdx.length };
}

// Enhanced trainModels with all 5 guards
function trainModelsGuarded(rows, features, horizon, warmStart=null, featWeights=null) {
  const warnings=[];
  const isSmall = rows.length < SMALL_DATASET_THRESH;

  const X=[],yDir=[],yRet=[];
  for(let i=50;i<rows.length-horizon;i++){
    if(rows[i]?._boundary||rows[i+horizon]?._boundary) continue;
    const f=fv(features[i],featWeights); if(f.some(v=>!isFinite(v))) continue;
    const ret=(rows[i+horizon].close-rows[i].close)/rows[i].close;
    X.push(f);
    yDir.push(labelDirection(ret*100, horizon)); // U3: 3-class
    yRet.push(ret*100);
  }

  if(X.length<MIN_TRAIN_SAMPLES){
    warnings.push({level:"error",msg:`Only ${X.length} training samples (min ${MIN_TRAIN_SAMPLES}). Add more historical data.`});
  }
  if(X.length<30) return {model:null, warnings, ensemble:null};

  const yUp  = yDir.map(v=>v===2?1:0);
  const yDown = yDir.map(v=>v===0?1:0);
  const flatPct = yDir.filter(v=>v===1).length/yDir.length;

  let norm;
  if(warmStart?.norm && warmStart.norm.mean?.length===(X[0]?.length||0)){
    norm=warmStart.norm;
  } else {
    norm=new Normaliser(); norm.fit(X);
    if(warmStart) warmStart=null;
  }
  const Xn=norm.transform(X);

  let clf_up, clf_down, gbdt_up, gbdt_down, reg;
  if(warmStart){
    clf_up   = warmStart.clf_up||warmStart.clf; clf_up.lr=0.01;
    clf_down = warmStart.clf_down||new LogReg({lr:0.05,epochs:400,l2:0.002});
    reg      = warmStart.reg;
    clf_up.partialFit(Xn,yUp,200); clf_down.partialFit(Xn,yDown,150);
    reg.partialFit(Xn,yRet,80);
    gbdt_up  = new GBDT({nTrees:60,lr:0.1,mode:"classifier"}); gbdt_up.fit(Xn,yUp);
    gbdt_down= new GBDT({nTrees:60,lr:0.1,mode:"classifier"}); gbdt_down.fit(Xn,yDown);
  } else {
    // Compute class weights (inverse frequency) for this training set
    const nUpG=yUp.filter(v=>v===1).length, nDnG=yDown.filter(v=>v===1).length;
    const totG=yUp.length;
    const cwUpG={1:totG/(2*nUpG+1e-8), 0:totG/(2*(totG-nUpG)+1e-8)};
    const cwDnG={1:totG/(2*nDnG+1e-8), 0:totG/(2*(totG-nDnG)+1e-8)};
    clf_up   = new LogReg({lr:0.05,epochs:400,l2:0.002}); clf_up.fit(Xn,yUp,cwUpG);
    clf_down = new LogReg({lr:0.05,epochs:400,l2:0.002}); clf_down.fit(Xn,yDown,cwDnG);
    gbdt_up  = new GBDT({nTrees:60,lr:0.1,mode:"classifier"}); gbdt_up.fit(Xn,yUp);
    gbdt_down= new GBDT({nTrees:60,lr:0.1,mode:"classifier"}); gbdt_down.fit(Xn,yDown);
    reg=new LinReg(); reg.fit(Xn,yRet);
  }

  // In-sample accuracy (optimistic — use BT for real number)
  const split=Math.floor(X.length*0.8);
  let correct=0, gbdtCorrect=0, lrCorrect=0;
  for(let i=split;i<X.length;i++){
    const xn=Xn[i];
    const ensUp  =ensembleProb(clf_up,  gbdt_up,  xn, null);
    const ensDown=ensembleProb(clf_down, gbdt_down, xn, null);
    const pred   =ensUp>0.55?2:ensDown>0.55?0:1;
    if(pred===yDir[i]) correct++;
    const gbPred=gbdt_up.predict(xn)>0.55?2:gbdt_down.predict(xn)>0.55?0:1;
    if(gbPred===yDir[i]) gbdtCorrect++;
    const lrPred=clf_up.predict(xn)>0.55?2:clf_down.predict(xn)>0.55?0:1;
    if(lrPred===yDir[i]) lrCorrect++;
  }
  const testN=X.length-split||1;
  const accuracy     =correct/testN;
  const gbdtAccuracy =gbdtCorrect/testN;
  const lrAccuracy   =lrCorrect/testN;

  const ensemble=trainEnsembleModels(rows,features,horizon);
  if(!ensemble?.stable&&!ensemble?.volatile) warnings.push({level:"info",msg:"Not enough data per regime for ensemble"});
  else warnings.push({level:"success",msg:`Ensemble: ${ensemble.stableCount} stable rows, ${ensemble.volatileCount} volatile rows`});

  warnings.push({level:"info",msg:`Flat labels: ${Math.round(flatPct*100)}% of moves within deadband — cleaner UP/DOWN signal`});

  return { model:{clf_up,clf_down,gbdt_up,gbdt_down,clf:clf_up,reg,norm,horizon,
    accuracy,gbdtAccuracy,lrAccuracy,trainSize:X.length,flatPct}, warnings, ensemble };
}

// ─── SECTOR MOMENTUM (Gap 5) — NASI proxy from all loaded stocks ─────────────
// Computes the average 5-day return across all uploaded stocks as a market
// momentum proxy. If 4 of 5 NSE stocks are up, that's bullish context.
function computeSectorMomentum(stockDataMap, excludeName) {
  const returns = [];
  for(const [name, sd] of Object.entries(stockDataMap)) {
    if(name === excludeName || !sd?.rows || sd.rows.length < 10) continue;
    const rows = sd.rows;
    const last = rows[rows.length-1].close;
    const prev5 = rows[Math.max(0, rows.length-6)].close;
    if(prev5 > 0) returns.push((last - prev5) / prev5 * 100);
  }
  if(!returns.length) return null;
  return returns.reduce((s,r)=>s+r,0) / returns.length;
}

// Gap 3+4+5+6: full guarded prediction with sector momentum + Kelly
function generatePredictionGuarded(stockData, macro, stockDataMap={}) {
  const {rows,features,models,name}=stockData;
  if(!rows||rows.length<60||!features) return null;
  const lastIdx=rows.length-1; const f=features[lastIdx]; const expert=EXPERT_BASE[name];
  const p30=findPatterns(features,rows,lastIdx,30);
  const p60=findPatterns(features,rows,lastIdx,60);
  const p90=findPatterns(features,rows,lastIdx,90);
  const patTgt=(ps)=>{if(!ps.length)return null;const w=ps.reduce((s,p)=>s+p.futureReturn*p.sim,0),t=ps.reduce((s,p)=>s+p.sim,0);return t>0?w/t:null;};
  const pt30=patTgt(p30),pt60=patTgt(p60),pt90=patTgt(p90);
  const curRegime=classifyRowRegime(f);

  // Gap 5: sector momentum context
  const sectorMom = computeSectorMomentum(stockDataMap, name);
  const sectorBias = sectorMom !== null ? (sectorMom > 1 ? 0.03 : sectorMom < -1 ? -0.03 : 0) : 0;

  let modelProb=0.5, probUp=0.5, probDown=0.25, probFlat=0.25, modelRet30=pt30;
  let lrRawUp=0.5, gbRawUp=0.5, patRaw=null;

  if(models?.m30){
    const xnArr = models.m30.norm.transform([fv(f)]);
    const xn = xnArr[0];

    // U4: ensemble probability for UP and DOWN
    lrRawUp  = models.m30.clf_up  ? models.m30.clf_up.predict(xn)  : (models.m30.clf ? models.m30.clf.predict(xn) : 0.5);
    gbRawUp  = models.m30.gbdt_up ? models.m30.gbdt_up.predict(xn) : lrRawUp;
    patRaw   = p30.length >= 5 ? p30.filter(p=>p.futureReturn>0).length/p30.length : null;

    probUp   = ensembleProb(models.m30.clf_up||models.m30.clf, models.m30.gbdt_up, xn, p30);
    probDown = ensembleProb(models.m30.clf_down, models.m30.gbdt_down, xn,
      p30.map(p=>({...p, futureReturn:-p.futureReturn}))); // invert for DOWN
    probFlat = Math.max(0, Math.min(1, 1 - probUp - probDown));
    // Normalise to sum to 1
    const total = probUp + probDown + probFlat;
    if(total > 0) { probUp/=total; probDown/=total; probFlat/=total; }

    modelProb = probUp + sectorBias;
    modelProb = Math.max(0.01, Math.min(0.99, modelProb));

    const mr = models.m30.reg.predict(xn);
    modelRet30 = pt30!==null?(mr*0.5+pt30*0.5):mr;
  }

  // Guard 4: confidence filter — use probUp distance from 0.5
  const probDist=Math.abs(modelProb-0.5);
  const forcedNeutral=probDist<CONFIDENCE_NEUTRAL_BAND;

  const cur=rows[lastIdx].close;
  const mkT=(ret)=>ret!==null?cur*(1+ret/100):null;

  const btObj = models?.backtest;
  const btAcc = btObj?.avgAccuracy ?? 0.5;

  // 2f: Adaptive confidence weighting
  let conf=50;
  if(btObj) conf=btAcc*100;
  const pa=p30.filter(p=>modelProb>0.5?p.futureReturn>0:p.futureReturn<0).length/(p30.length||1);
  let modelWeight=0.6, patternWeight=0.4;
  if(btObj?.calibration?.poorlyCalibrated===false && btAcc>0.58){
    modelWeight=0.8; patternWeight=0.2;
  } else if(btAcc<0.52 || !btObj?.calibration){
    modelWeight=0.4; patternWeight=0.6;
  }
  conf=Math.round(Math.max(0,Math.min(99,conf*modelWeight+pa*100*patternWeight)));

  // 4a: Neutral zone gate
  const neutralReasons = [];
  if(p30.length < 5) neutralReasons.push(`Only ${p30.length} pattern matches (need ≥5 with sim>0.7)`);
  if(btObj?.informationRatio != null && btObj.informationRatio < 1.0) neutralReasons.push(`IR=${btObj.informationRatio.toFixed(2)} < 1.0 — no significant edge`);
  if(models?.m30?.trainSize != null && models.m30.trainSize < 150) neutralReasons.push(`Only ${models.m30.trainSize} training samples (need ≥150)`);
  // Force NEUTRAL if overall confidence is too low regardless of prob values
  if(conf < 20) neutralReasons.push(`Confidence ${conf}% below minimum threshold (20%) — model has no demonstrated edge`);

  // OOD detection: if current price is outside the training price range,
  // reduce signal confidence — the model never saw this price level.
  // This prevents the "stuck at DOWN with 21% conf" issue when price breaks out.
  if(models?.trainPriceMin!=null && models?.trainPriceMax!=null) {
    const curPrice = rows[rows.length-1]?.close;
    if(curPrice && (curPrice < models.trainPriceMin || curPrice > models.trainPriceMax)) {
      const pct = curPrice > models.trainPriceMax
        ? ((curPrice - models.trainPriceMax) / models.trainPriceMax * 100).toFixed(0)
        : ((models.trainPriceMin - curPrice) / models.trainPriceMin * 100).toFixed(0);
      neutralReasons.push(`Current price ${curPrice.toFixed(2)} is ${pct}% outside the training price range — model is extrapolating beyond its training data`);
    }
  }

  const gateNeutral = neutralReasons.length > 0;

  // U3: 3-class signal
  const signal = (forcedNeutral||gateNeutral) ? "HOLD"
    : probUp>0.55?"BUY":probDown>0.55?"SELL":"HOLD";

  // Gap 6: Kelly criterion — correct formula f* = (p*b - q) / b
  // p = win rate, q = loss rate, b = avg_win / |avg_loss|
  const aggM = btObj?.aggregate;
  const kP = aggM?.winRate ?? (btAcc ?? 0.5);
  const kQ = 1 - kP;
  const kB = (aggM?.avgWin && aggM?.avgLoss && aggM.avgLoss !== 0)
    ? Math.abs(aggM.avgWin / aggM.avgLoss) : 1;
  const kellyFull = kB > 0 ? (kP * kB - kQ) / kB : 0;
  const kelly = Math.max(0, kellyFull * 0.5); // half-Kelly for safety
  const maxAlloc = expert?.maxAlloc ?? 20;
  const kellyPct = Math.min(maxAlloc, Math.round(kelly * 100));
  // 2d: Kelly transparency data for UI
  const kellyData = aggM
    ? { p: kP, b: kB, q: kQ, source: "backtest" }
    : { p: kP, b: kB, q: kQ, source: "fallback" };

  // Volume warning
  const last20Vols=rows.slice(-20).map(r=>r.volume);
  const avgVol20=last20Vols.reduce((s,v)=>s+v,0)/last20Vols.length;
  const lowLiquidityWarning=avgVol20<50000&&expert?.liq===3;

  // Dividend capture check
  const dividendCapture=checkDividendCapture(name||"");

  return {
    signal,confidence:conf,modelProb,probUp,probDown,probFlat,
    forcedNeutral,gateNeutral,neutralReasons,curRegime,
    ensembleBreakdown: models?.m30 ? {
      lrProb:lrRawUp, gbProb:gbRawUp, patProb:patRaw,
      lrWeight:ENSEMBLE_WEIGHTS.logreg, gbWeight:ENSEMBLE_WEIGHTS.gbdt,
      patWeight:patRaw!=null?ENSEMBLE_WEIGHTS.pattern:0,
    } : null,
    target30:mkT(modelRet30),target60:mkT(pt60),target90:mkT(pt90),
    pctTarget30:modelRet30,pctTarget60:pt60,pctTarget90:pt90,
    patterns30:p30,patterns60:p60,patterns90:p90,
    riskScore:calcRisk(f,expert),currentFeatures:f,
    modelAccuracy:btObj?.avgAccuracy??null,
    guardWarnings: models?.trainWarnings||[],
    sectorMomentum: sectorMom,
    kellyPct, kellyRaw: kelly, kellyData,
    accuracyTrend: btObj?.accuracyTrend ?? 0,
    lowLiquidityWarning,
    dividendCapture,
    modelWeight, patternWeight,
  };
}


// ─── HELPERS ─────────────────────────────────────────────────────────────────
const LAB_STOCKS = ["Stanbic Bank","Co-op Bank","Kenya Re","ABSA NewGold ETF","Crown Paints"];
const LAB_TICKERS = {"Stanbic Bank":"SBIC","Co-op Bank":"COOP","Kenya Re":"KNRE","ABSA NewGold ETF":"GLD","Crown Paints":"BERG"};
const LAB_PAPER_KEY = "iq_lab_paper";
const LAB_JOURNAL_KEY = "iq_lab_journal";
const LAB_CHECKIN_KEY = "iq_lab_checkin";
const LAB_PAPER_START = 100000;

function loadLabPaper() {
  const p = db.load(LAB_PAPER_KEY, {value:LAB_PAPER_START, trades:[], startedAt:new Date().toISOString()});
  // Dedup: keep only one open trade per stock per day (latest by id)
  if(p.trades && p.trades.length > 0){
    const seen = new Map();
    const deduped = [];
    for(const t of [...p.trades].reverse()){
      const key = t.closed ? t.id : `${t.stock}_${t.date}_open`;
      if(!seen.has(key)){ seen.set(key, true); deduped.unshift(t); }
    }
    p.trades = deduped;
  }
  return p;
}
function saveLabPaper(p) { db.save(LAB_PAPER_KEY, p); }
function loadLabJournal() { return db.load(LAB_JOURNAL_KEY, [])||[]; }
function retroactivelyFixJournal() {
  // Fix entries scored with wrong band — re-evaluate using stock-specific bands
  const STOCK_BANDS = {"Stanbic Bank":1.5,"Co-op Bank":1.0,"Kenya Re":1.0,"ABSA NewGold ETF":2.0,"Crown Paints":1.0};
  const j = loadLabJournal();
  let changed = false;
  const fixed = j.map(e => {
    if(e.actual == null || e.price == null) return e;
    // We can't re-evaluate without knowing the next day's price
    // But we can fix entries where signal was BUY/SELL and result seems wrong
    // This will be handled naturally on next check-in with correct bands
    return e;
  });
  return j;
}
function saveLabJournal(j) { db.save(LAB_JOURNAL_KEY, j.slice(-200)); }
function loadLabCheckin() { return db.load(LAB_CHECKIN_KEY, {})||{}; }
function saveLabCheckin(c) { db.save(LAB_CHECKIN_KEY, c); }

// ─── Exports for the server-side pipeline (nseSync.ts) ──────────────────────
export {
  db,
  buildFeaturesForStock,
  trainModelsGuarded,
  walkForwardBacktest,
  generatePredictionGuarded,
  saveModelWeights,
  loadModelWeights,
  appendLearningHistory,
  loadLearningHistory,
  STOCK_KEY,
  loadStockData,
  saveStockData,
  listStocks,
  getDeadband,
  labelDirection,
  LAB_STOCKS,
  LAB_TICKERS,
  loadLabPaper,
  saveLabPaper,
  loadLabJournal,
  saveLabJournal,
  loadLabCheckin,
  saveLabCheckin,
};
