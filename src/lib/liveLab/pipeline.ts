// @ts-nocheck
import { db as remoteDb } from '@/lib/database'
import { supabaseAdmin } from '@/lib/supabase/client'
import {
  db as engineDb,
  hydrateEngineStore,
  dumpEngineStore,
  buildFeaturesForStock,
  trainModelsGuarded,
  walkForwardBacktest,
  generatePredictionGuarded,
  saveModelWeights,
  STOCK_KEY,
  loadStockData,
  LAB_STOCKS,
  LAB_TICKERS,
} from './engine'

// ── Shadow mode ──────────────────────────────────────────────────────────────
// These two keys are SEPARATE from your real iq_lab_journal / iq_lab_paper.
// The automated pipeline writes its predictions, evaluations, and paper
// trades here instead — so it can run every weekday alongside your manual
// check-ins without touching your real track record, until we've confirmed
// it produces the same results a human clicking through the UI would.
//
// Model weights, learning history, and iq_train_results DO update the real
// keys (iq_weights_*, iq_lhist_*, iq_train_results) — that's equivalent to
// you clicking "Retrain" yourself on new data, carries no risk to any
// existing track record, and there's no reason to shadow it.
const SHADOW_JOURNAL_KEY = 'iq_lab_journal_auto'
const SHADOW_PAPER_KEY = 'iq_lab_paper_auto'
const SHADOW_PAPER_START = 100000

// ── Roster (Phase C) ──────────────────────────────────────────────────────────
// NOT wired into the daily cron yet — only reachable via the manual
// ?runRoster=true endpoint until you've reviewed a week of Phase B results
// and we decide together to make it part of the automatic daily run.
const ROSTER_KEY = 'iq_lab_roster'
const LEADERBOARD_KEY = 'iq_lab_leaderboard_monthly'
const MAX_ACTIVE_STOCKS = 10
const RANKING_WINDOW_DAYS = 5 // "a week" of trading days
const LEADERBOARD_WINDOW_DAYS = 20 // "a month" of trading days
const MIN_SAMPLE_FOR_RANKING = 5 // don't judge a stock on fewer than this many scored predictions
const MAX_CATCHUP_DAYS = 20 // safety cap — see catchUpStock's comment for why this exists

const STOCK_BANDS = {
  'Stanbic Bank': 1.5,
  'Co-op Bank': 1.0,
  'Kenya Re': 1.0,
  'ABSA NewGold ETF': 2.0,
  'Crown Paints': 1.0,
}
const DEFAULT_BAND = 1.5

function safeName(name) {
  return name.replace(/\s+/g, '_')
}

// Derives the model's RAW, pre-gate directional belief from its underlying
// probabilities — NOT from pred.signal, which is already post-gate (can be
// forced to neutral by the engine's internal IR/deadband guards). This is
// what gets written to `predictions` for the trading bot to read.
function deriveRawAction(pred) {
  const probUp = pred.probUp || 0
  const probDown = pred.probDown || 0
  const probFlat = pred.probFlat || 0
  // If probabilities are missing/malformed (all zero), don't let the tie-break
  // fall through to a false BUY at zero confidence — that's a nonsensical
  // signal to hand the bot.
  if (probUp === 0 && probDown === 0 && probFlat === 0) return { action: 'HOLD', confidence: 0 }
  if (probUp >= probDown && probUp >= probFlat) return { action: 'BUY', confidence: probUp }
  if (probDown >= probUp && probDown >= probFlat) return { action: 'SELL', confidence: probDown }
  return { action: 'HOLD', confidence: probFlat }
}

// Writes one row to the bot-facing `predictions` table per stock per day.
// Uses supabaseAdmin (service role) directly — this table is locked to
// service-role-only in RLS, and the trading bot reads it with its own
// service-role key from a completely separate process, never through this
// app's API.
async function writeRawPredictionForBot(name, date, price, pred) {
  if (!supabaseAdmin) return // no service role key configured — skip quietly
  const { action, confidence } = deriveRawAction(pred)
  const ticker = LAB_TICKERS[name] || name // Soko Play's search accepts either

  // The engine's own kellyPct/kellyRaw are ALREADY half-Kelly (see
  // engine.ts: `kelly = kellyFull * 0.5`, a built-in safety dampening for
  // the main app's own display). Since this table feeds the trading bot
  // running against virtual money — where you explicitly want full Kelly,
  // not the conservative version — we reconstruct the undamped fraction by
  // doubling it here, rather than touching engine.ts (which stays
  // byte-faithful to the browser app). Clamped at 100%: not a risk
  // decision, just "can't allocate more than the full account."
  const fullKellyPct = Math.min(100, (pred.kellyRaw || 0) * 2 * 100)

  try {
    await supabaseAdmin.from('predictions').upsert(
      {
        ticker,
        stock_name: name,
        date,
        price,
        action,
        confidence,
        kelly_pct: fullKellyPct,
        raw_prob_up: pred.probUp ?? null,
        raw_prob_down: pred.probDown ?? null,
        raw_prob_flat: pred.probFlat ?? null,
        engine_gated_action: pred.signal ?? null,
      },
      { onConflict: 'ticker,date' }
    )
  } catch (error) {
    console.error(`Failed to write raw prediction for ${name} (${date}):`, error)
  }
}

// ── Step 1: pull everything the engine needs from real Supabase into the
// in-memory store the extracted algorithm code runs against. ────────────────
async function hydrateFromSupabase(stockNames) {
  const records = {}

  for (const name of stockNames) {
    // CRITICAL: iq_stock_<name> is stored as a PLAIN ARRAY by the real app
    // (saveStockData/loadStockData), not {name, rows}. Loading it any other
    // way would look empty to the engine and risk the catch-up pipeline
    // treating a stock as having no history.
    records[STOCK_KEY(name)] = await remoteDb.load(STOCK_KEY(name), [])
    records[`iq_weights_${safeName(name)}`] = await remoteDb.load(`iq_weights_${safeName(name)}`, null)
    records[`iq_lhist_${safeName(name)}`] = await remoteDb.load(`iq_lhist_${safeName(name)}`, [])
  }

  records['iq_macro'] = await remoteDb.load('iq_macro', {
    cbk_rate: 13,
    inflation: 4.5,
    usd_kes: 129.5,
    gdp_growth: 5.0,
  })
  records['iq_events'] = await remoteDb.load('iq_events', [])
  records['iq_deadband'] = await remoteDb.load('iq_deadband', { 30: 2.0, 60: 3.5, 90: 5.0 })
  records['iq_train_results'] = await remoteDb.load('iq_train_results', {})

  records[SHADOW_JOURNAL_KEY] = await remoteDb.load(SHADOW_JOURNAL_KEY, [])
  records[SHADOW_PAPER_KEY] = await remoteDb.load(SHADOW_PAPER_KEY, {
    value: SHADOW_PAPER_START,
    trades: [],
    startedAt: new Date().toISOString(),
  })

  records[ROSTER_KEY] = await remoteDb.load(ROSTER_KEY, {})
  records[LEADERBOARD_KEY] = await remoteDb.load(LEADERBOARD_KEY, null)

  hydrateEngineStore(records)
}

// ── Step 2 (after all processing): push the in-memory results back out. ─────
async function persistToSupabase(stockNames) {
  const dump = dumpEngineStore()
  const writes = []

  for (const name of stockNames) {
    writes.push(remoteDb.save(STOCK_KEY(name), dump[STOCK_KEY(name)]))
    writes.push(remoteDb.save(`iq_weights_${safeName(name)}`, dump[`iq_weights_${safeName(name)}`]))
    writes.push(remoteDb.save(`iq_lhist_${safeName(name)}`, dump[`iq_lhist_${safeName(name)}`]))
  }
  writes.push(remoteDb.save('iq_train_results', dump['iq_train_results']))
  writes.push(remoteDb.save(SHADOW_JOURNAL_KEY, dump[SHADOW_JOURNAL_KEY]))
  writes.push(remoteDb.save(SHADOW_PAPER_KEY, dump[SHADOW_PAPER_KEY]))
  writes.push(remoteDb.save(ROSTER_KEY, dump[ROSTER_KEY]))
  if (dump[LEADERBOARD_KEY]) writes.push(remoteDb.save(LEADERBOARD_KEY, dump[LEADERBOARD_KEY]))

  await Promise.all(writes)
}

// Builds the cross-stock map buildFeaturesForStock/generatePredictionGuarded
// need (sector momentum etc.) from whatever's currently in the in-memory
// store — same shape as the browser's `stockDataMap` React state.
function buildStockDataMap(stockNames) {
  const map = {}
  for (const name of stockNames) {
    const data = loadStockData(name)
    if (data) map[name] = data
  }
  return map
}

// Evaluates one pending journal entry against a later actual close —
// same math as handleCheckin's evaluation block in InvestIQApp.tsx.
// Stocks outside the original 5 fall back to a 1.5% deadband — reasonable
// default, but you may want to tune per-stock as you see real results.
function evaluateEntry(entry, actualClose, paper) {
  const band = STOCK_BANDS[entry.stock] || DEFAULT_BAND
  const prevPrice = entry.price
  let actual = null
  let correct = null

  if (prevPrice) {
    const pctChange = ((actualClose - prevPrice) / prevPrice) * 100
    actual = pctChange > band ? 'UP' : pctChange < -band ? 'DOWN' : 'FLAT'
    const predDir = entry.signal === 'BUY' ? 'UP' : entry.signal === 'SELL' ? 'DOWN' : 'FLAT'
    correct = predDir === actual

    const openIdx = (paper.trades || []).findIndex(
      (t) => t.stock === entry.stock && t.date === entry.date && !t.closed
    )
    if (openIdx >= 0) {
      const t = paper.trades[openIdx]
      const pnl = (actualClose - t.entryPrice) * t.shares * (t.signal === 'SELL' ? -1 : 1)
      paper.trades[openIdx] = { ...t, exitPrice: actualClose, pnl, closed: true }
      paper.value = paper.value + pnl
    }
  }

  return { ...entry, actual, correct }
}

// Retrains through a given date and generates the next prediction — same
// steps as handleRetrain in InvestIQApp.tsx, just parameterised by date so
// it can be replayed for each day in a multi-day catch-up instead of only
// ever running against "today".
function retrainAndPredictThrough(name, uptoDate, stockNames) {
  const stockDataMap = buildStockDataMap(stockNames)
  const fullData = stockDataMap[name]
  if (!fullData) return null

  const rowsUpto = fullData.rows.filter((r) => r.date <= uptoDate)
  if (rowsUpto.length < 60) return null

  const lastDate = rowsUpto[rowsUpto.length - 1].date
  const cutoff = new Date(lastDate)
  cutoff.setFullYear(cutoff.getFullYear() - 2)
  const cutStr = cutoff.toISOString().split('T')[0]
  const filtered = rowsUpto.filter((r) => r.date >= cutStr)
  const rows = filtered.length >= 60 ? filtered : rowsUpto

  const features = buildFeaturesForStock(rows, name, null, null, stockDataMap)
  const g30 = trainModelsGuarded(rows, features, 30, null, null)
  const g60 = trainModelsGuarded(rows, features, 60, null, null)
  const g90 = trainModelsGuarded(rows, features, 90, null, null)
  const backtest = walkForwardBacktest(rows, features, 30, 5, name, true)
  const models = { m30: g30.model, m60: g60.model, m90: g90.model, backtest, trainedAt: new Date().toISOString() }
  if (g30.model) saveModelWeights(name, models, g30.model.norm)

  const trainResults = engineDb.load('iq_train_results', {})
  trainResults[name] = {
    ...(trainResults[name] || {}),
    from: rows[0]?.date || '',
    to: rows[rows.length - 1]?.date || '',
    rows: rows.length,
    trainedAt: new Date().toISOString(),
    runCount: (trainResults[name]?.runCount || 0) + 1,
    accuracy: backtest?.avgAccuracy || 0,
  }
  engineDb.save('iq_train_results', trainResults)

  const updated = { ...fullData, rows, features, models, name }
  const pred = generatePredictionGuarded(updated, null, stockDataMap)
  return { pred, lastClose: rows[rows.length - 1].close, backtest }
}

// Processes every trading day this stock has stored data for but hasn't yet
// had a journal cycle for — the actual "catch-up" fix. If 5 days passed
// since the last run, this produces 5 evaluate+retrain+predict cycles, not 1.
async function catchUpStock(name, stockNames) {
  const data = loadStockData(name)
  if (!data || data.rows.length < 60) {
    return { stockName: name, status: 'insufficient_data', rowCount: data?.rows?.length || 0 }
  }

  const journal = engineDb.load(SHADOW_JOURNAL_KEY, [])
  const paper = engineDb.load(SHADOW_PAPER_KEY, { value: SHADOW_PAPER_START, trades: [] })

  const stockJournal = journal.filter((e) => e.stock === name)
  const lastProcessedDate = stockJournal.length > 0 ? stockJournal[stockJournal.length - 1].date : null

  // Every stored trading day after the last one we already made a
  // prediction for, in chronological order.
  let pendingDates = data.rows.map((r) => r.date).filter((d) => !lastProcessedDate || d > lastProcessedDate)

  // CRITICAL CAP: a brand-new stock (no journal history at all) would
  // otherwise have pendingDates = its ENTIRE multi-year row history —
  // hundreds or thousands of full retrain+backtest cycles run
  // sequentially. That's not a "catch up a few missed days" situation,
  // it's a runaway job that would blow any serverless timeout and serves
  // no purpose (nobody needs 2 years of backtested daily predictions
  // replayed). Cap to the most recent MAX_CATCHUP_DAYS trading days —
  // gives a real, meaningful track record to start ranking from without
  // trying to reconstruct all of history. Applies to ANY gap this large,
  // not just brand-new stocks (e.g. a stock re-added after a long pause).
  if (pendingDates.length > MAX_CATCHUP_DAYS) {
    console.warn(
      `[catchUpStock] ${name}: ${pendingDates.length} pending days, capping to the most recent ${MAX_CATCHUP_DAYS}.`
    )
    pendingDates = pendingDates.slice(-MAX_CATCHUP_DAYS)
  }

  if (pendingDates.length === 0) {
    return { stockName: name, status: 'up_to_date' }
  }

  const cyclesRun = []

  for (const date of pendingDates) {
    const row = data.rows.find((r) => r.date === date)

    // 1. Evaluate the most recent still-pending prediction against today's
    // actual close, if one exists.
    const pendingIdx = journal.findIndex((e) => e.stock === name && e.actual == null && e.date < date)
    if (pendingIdx >= 0) {
      journal[pendingIdx] = evaluateEntry(journal[pendingIdx], row.close, paper)
    }

    // 2. Retrain through this date and generate the next prediction.
    const result = retrainAndPredictThrough(name, date, stockNames)
    if (result?.pred) {
      await writeRawPredictionForBot(name, date, row.close, result.pred)

      const alreadyLogged = journal.some((e) => e.date === date && e.stock === name)
      if (!alreadyLogged) {
        const entry = {
          id: Date.now() + Math.random(),
          date,
          stock: name,
          ticker: LAB_TICKERS[name] || null, // null = no known live ticker for this stock yet
          signal: result.pred.signal,
          confidence: result.pred.confidence,
          probUp: Math.round((result.pred.probUp || 0) * 100),
          actual: null,
          correct: null,
          price: row.close,
        }
        journal.push(entry)

        if (result.pred.signal !== 'HOLD' && result.lastClose > 0) {
          const alloc = Math.floor(paper.value * 0.15)
          const shares = Math.floor(alloc / result.lastClose)
          if (shares > 0) {
            paper.trades = paper.trades || []
            paper.trades.push({
              id: Date.now() + Math.random(),
              date,
              stock: name,
              signal: result.pred.signal,
              shares,
              entryPrice: result.lastClose,
              pnl: null,
              closed: false,
            })
          }
        }
      }
      cyclesRun.push({ date, signal: result.pred.signal, backtestAccuracy: result.backtest?.avgAccuracy || null })
    }
  }

  engineDb.save(SHADOW_JOURNAL_KEY, journal.slice(-2000))
  engineDb.save(SHADOW_PAPER_KEY, paper)

  return { stockName: name, status: 'caught_up', cyclesRun }
}

// Entry point called from nseSync.ts after the day's prices are scraped in.
// UNCHANGED from before — still only the original 5 stocks. This keeps
// today's production behavior exactly as-is; the roster/rotation system
// below is a separate, not-yet-wired-in path.
export async function runLiveLabCatchup() {
  await hydrateFromSupabase(LAB_STOCKS)

  const results = []
  for (const name of LAB_STOCKS) {
    try {
      results.push(await catchUpStock(name, LAB_STOCKS))
    } catch (error) {
      console.error(`Live Lab catch-up failed for ${name}:`, error)
      results.push({ stockName: name, status: 'error', error: error instanceof Error ? error.message : String(error) })
    }
  }

  await persistToSupabase(LAB_STOCKS)
  return results
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase C: roster / rotation / leaderboard — MANUAL TRIGGER ONLY for now.
// Not called by the daily cron. Reachable via GET /api/nse/fetch?runRoster=true
// until you've reviewed Phase B's results and want this wired into the
// automatic daily run too.
// ═══════════════════════════════════════════════════════════════════════════

// Finds every stock that has both price history AND a trained model —
// i.e. everything eligible for Live Lab, not just the original 5.
async function discoverTrainedStocks() {
  const stockKeys = await remoteDb.keys('iq_stock_')
  const weightKeys = await remoteDb.keys('iq_weights_')
  const weightedSafeNames = new Set(weightKeys.map((k) => k.replace('iq_weights_', '')))

  const names = []
  for (const key of stockKeys) {
    const safe = key.replace('iq_stock_', '')
    if (weightedSafeNames.has(safe)) {
      names.push(safe.replace(/_/g, ' '))
    }
  }
  return names
}

// Rolling accuracy over the last N trading days this stock has a *scored*
// prediction for (actual != null) — not the last N calendar days, since
// weekends/gaps would water that down.
function computeRollingAccuracy(stockName, journal, windowSize) {
  const scored = journal
    .filter((e) => e.stock === stockName && e.actual != null)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
  const recent = scored.slice(-windowSize)
  if (recent.length === 0) return { accuracy: null, sampleSize: 0 }
  const correct = recent.filter((e) => e.correct).length
  return { accuracy: correct / recent.length, sampleSize: recent.length }
}

// Registers newly-trained stocks, promotes/relegates between active and
// benched based on rolling weekly accuracy, and rebuilds the monthly
// leaderboard. Operates on the already-hydrated in-memory store.
function rotateRoster(trainedStocks) {
  const roster = engineDb.load(ROSTER_KEY, {})
  const journal = engineDb.load(SHADOW_JOURNAL_KEY, [])
  const today = new Date().toISOString().split('T')[0]

  // Register newcomers as benched; refresh ticker info for everyone.
  for (const name of trainedStocks) {
    if (!roster[name]) {
      roster[name] = {
        tier: 'benched',
        ticker: LAB_TICKERS[name] || null,
        joinedAt: today,
        lastPromotedAt: null,
        lastBenchedAt: null,
      }
    } else {
      roster[name].ticker = LAB_TICKERS[name] || roster[name].ticker || null
    }
  }
  // Drop anything that no longer has a trained model.
  for (const name of Object.keys(roster)) {
    if (!trainedStocks.includes(name)) delete roster[name]
  }

  const scores = {}
  for (const name of trainedStocks) {
    scores[name] = computeRollingAccuracy(name, journal, RANKING_WINDOW_DAYS)
  }

  let activeNames = Object.entries(roster)
    .filter(([, r]) => r.tier === 'active')
    .map(([n]) => n)
  let benchedNames = Object.entries(roster)
    .filter(([, r]) => r.tier === 'benched')
    .map(([n]) => n)

  const rankBenchedBestFirst = () =>
    benchedNames.sort((a, b) => {
      const sa = scores[a]
      const sb = scores[b]
      if (sa.accuracy == null && sb.accuracy == null) return 0
      if (sa.accuracy == null) return 1
      if (sb.accuracy == null) return -1
      return sb.accuracy - sa.accuracy
    })

  // Fill any empty active slots first — no minimum sample required here,
  // since an empty slot beats leaving it empty even for a brand-new stock.
  rankBenchedBestFirst()
  while (activeNames.length < MAX_ACTIVE_STOCKS && benchedNames.length > 0) {
    const promote = benchedNames.shift()
    roster[promote].tier = 'active'
    roster[promote].lastPromotedAt = today
    activeNames.push(promote)
  }

  // Once full, only swap a stock out if a benched one has BOTH enough of a
  // track record (min sample) AND a genuinely better rolling accuracy than
  // the worst-performing active stock (which also needs a minimum sample —
  // don't relegate a stock just because it's too new to judge yet).
  if (activeNames.length >= MAX_ACTIVE_STOCKS) {
    const rankedActiveWorstFirst = [...activeNames].sort(
      (a, b) => (scores[a].accuracy ?? -1) - (scores[b].accuracy ?? -1)
    )
    const eligibleBenched = benchedNames
      .filter((n) => scores[n].sampleSize >= MIN_SAMPLE_FOR_RANKING)
      .sort((a, b) => scores[b].accuracy - scores[a].accuracy)

    const worstActive = rankedActiveWorstFirst[0]
    const bestBenched = eligibleBenched[0]

    if (
      worstActive &&
      bestBenched &&
      scores[worstActive].sampleSize >= MIN_SAMPLE_FOR_RANKING &&
      scores[bestBenched].accuracy > scores[worstActive].accuracy
    ) {
      roster[worstActive].tier = 'benched'
      roster[worstActive].lastBenchedAt = today
      roster[bestBenched].tier = 'active'
      roster[bestBenched].lastPromotedAt = today
    }
  }

  engineDb.save(ROSTER_KEY, roster)

  // Monthly leaderboard — everyone, active or benched, ranked by rolling
  // 20-trading-day accuracy, so you can see the full picture.
  const rankings = trainedStocks
    .map((name) => {
      const s = computeRollingAccuracy(name, journal, LEADERBOARD_WINDOW_DAYS)
      return { stock: name, tier: roster[name].tier, accuracy: s.accuracy, sampleSize: s.sampleSize }
    })
    .sort((a, b) => (b.accuracy ?? -1) - (a.accuracy ?? -1))

  const leaderboard = { updatedAt: new Date().toISOString(), rankings }
  engineDb.save(LEADERBOARD_KEY, leaderboard)

  return { roster, leaderboard }
}

// The Phase C entry point: catch up EVERY trained stock (not just the
// original 5), then run promotion/relegation, then persist everything.
export async function runFullRosterCatchupAndRotation() {
  const trainedStocks = await discoverTrainedStocks()
  if (trainedStocks.length === 0) {
    return { error: 'No trained stocks found — train at least one stock in the app first.' }
  }

  await hydrateFromSupabase(trainedStocks)

  const catchupResults = []
  for (const name of trainedStocks) {
    try {
      catchupResults.push(await catchUpStock(name, trainedStocks))
    } catch (error) {
      console.error(`Roster catch-up failed for ${name}:`, error)
      catchupResults.push({
        stockName: name,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const { roster, leaderboard } = rotateRoster(trainedStocks)

  await persistToSupabase(trainedStocks)

  return { trainedStockCount: trainedStocks.length, catchupResults, roster, leaderboard }
}
