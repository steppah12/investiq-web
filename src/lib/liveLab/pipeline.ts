// @ts-nocheck
import { db as remoteDb } from '@/lib/database'
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

const STOCK_BANDS = {
  'Stanbic Bank': 1.5,
  'Co-op Bank': 1.0,
  'Kenya Re': 1.0,
  'ABSA NewGold ETF': 2.0,
  'Crown Paints': 1.0,
}

function safeName(name) {
  return name.replace(/\s+/g, '_')
}

// ── Step 1: pull everything the engine needs from real Supabase into the
// in-memory store the extracted algorithm code runs against. ────────────────
async function hydrateFromSupabase() {
  const records = {}

  for (const name of LAB_STOCKS) {
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

  hydrateEngineStore(records)
}

// ── Step 2 (after all processing): push the in-memory results back out. ─────
async function persistToSupabase() {
  const dump = dumpEngineStore()
  const writes = []

  for (const name of LAB_STOCKS) {
    writes.push(remoteDb.save(STOCK_KEY(name), dump[STOCK_KEY(name)]))
    writes.push(remoteDb.save(`iq_weights_${safeName(name)}`, dump[`iq_weights_${safeName(name)}`]))
    writes.push(remoteDb.save(`iq_lhist_${safeName(name)}`, dump[`iq_lhist_${safeName(name)}`]))
  }
  writes.push(remoteDb.save('iq_train_results', dump['iq_train_results']))
  writes.push(remoteDb.save(SHADOW_JOURNAL_KEY, dump[SHADOW_JOURNAL_KEY]))
  writes.push(remoteDb.save(SHADOW_PAPER_KEY, dump[SHADOW_PAPER_KEY]))

  await Promise.all(writes)
}

// Builds the cross-stock map buildFeaturesForStock/generatePredictionGuarded
// need (sector momentum etc.) from whatever's currently in the in-memory
// store — same shape as the browser's `stockDataMap` React state.
function buildStockDataMap() {
  const map = {}
  for (const name of LAB_STOCKS) {
    const data = loadStockData(name)
    if (data) map[name] = data
  }
  return map
}

// Evaluates one pending journal entry against a later actual close —
// same math as handleCheckin's evaluation block in InvestIQApp.tsx.
function evaluateEntry(entry, actualClose, paper) {
  const band = STOCK_BANDS[entry.stock] || 1.5
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
function retrainAndPredictThrough(name, uptoDate) {
  const stockDataMap = buildStockDataMap()
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
function catchUpStock(name) {
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
  const pendingDates = data.rows.map((r) => r.date).filter((d) => !lastProcessedDate || d > lastProcessedDate)

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
    const result = retrainAndPredictThrough(name, date)
    if (result?.pred) {
      const alreadyLogged = journal.some((e) => e.date === date && e.stock === name)
      if (!alreadyLogged) {
        const entry = {
          id: Date.now() + Math.random(),
          date,
          stock: name,
          ticker: LAB_TICKERS[name],
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

  engineDb.save(SHADOW_JOURNAL_KEY, journal.slice(-500))
  engineDb.save(SHADOW_PAPER_KEY, paper)

  return { stockName: name, status: 'caught_up', cyclesRun }
}

// Entry point called from nseSync.ts after the day's prices are scraped in.
export async function runLiveLabCatchup() {
  await hydrateFromSupabase()

  const results = []
  for (const name of LAB_STOCKS) {
    try {
      results.push(catchUpStock(name))
    } catch (error) {
      console.error(`Live Lab catch-up failed for ${name}:`, error)
      results.push({ stockName: name, status: 'error', error: error instanceof Error ? error.message : String(error) })
    }
  }

  await persistToSupabase()
  return results
}
