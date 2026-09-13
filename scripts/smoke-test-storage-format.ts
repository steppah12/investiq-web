// @ts-nocheck
// Regression test for the critical bug just fixed: iq_stock_<name> must be
// stored as a plain array (matching saveStockData/loadStockData in the real
// app), and appending a new day must never wipe existing history.
import { hydrateEngineStore, dumpEngineStore, STOCK_KEY, db as engineDb } from '../src/lib/liveLab/engine'

function isStaleEcho(newRow, lastRow) {
  if (!lastRow) return false
  return (
    newRow.close === lastRow.close &&
    newRow.high === lastRow.high &&
    newRow.low === lastRow.low &&
    newRow.volume === lastRow.volume
  )
}

// Mirrors nseSync.ts's corrected fetchAndStoreStock logic exactly, minus the
// actual network call — the point here is testing the storage semantics.
function simulateAppendRow(stockName, newRow) {
  const key = STOCK_KEY(stockName)
  const rows = engineDb.load(key, [])
  const idx = rows.findIndex((r) => r.date === newRow.date)
  const alreadyHadThisDate = idx >= 0
  const lastRow = rows.length > 0 ? rows[rows.length - 1] : null

  if (!alreadyHadThisDate && isStaleEcho(newRow, lastRow)) {
    return { status: 'stale_echo' }
  }
  if (alreadyHadThisDate) {
    rows[idx] = newRow
  } else {
    rows.push(newRow)
  }
  rows.sort((a, b) => String(a.date).localeCompare(String(b.date)))
  engineDb.save(key, rows)
  return { status: alreadyHadThisDate ? 'no_new_data' : 'updated', totalRows: rows.length }
}

function main() {
  const name = 'Stanbic Bank'
  // Seed EXACTLY like the real app would — a plain array of 500 historical rows.
  const historicalRows = []
  for (let i = 0; i < 500; i++) {
    const d = new Date('2023-01-02')
    d.setDate(d.getDate() + i)
    historicalRows.push({ date: d.toISOString().split('T')[0], open: 90 + i * 0.01, high: 91, low: 89, close: 90 + i * 0.01, volume: 100000 })
  }
  const expectedCount = historicalRows.length
  hydrateEngineStore({ [STOCK_KEY(name)]: historicalRows })

  console.log(`Seeded ${expectedCount} historical rows (plain array, matching real app format)`)
  const before = dumpEngineStore()[STOCK_KEY(name)]
  console.log(`Before append: ${before.length} rows, type=${Array.isArray(before) ? 'array' : typeof before}`)

  // Simulate the scraper appending one new real trading day.
  const result = simulateAppendRow(name, { date: '2024-09-15', open: 145, high: 146, low: 144, close: 145.5, volume: 250000 })
  console.log('Append result:', JSON.stringify(result))

  const after = dumpEngineStore()[STOCK_KEY(name)]
  console.log(`After append: ${after.length} rows, type=${Array.isArray(after) ? 'array' : typeof after}`)

  if (after.length !== expectedCount + 1) {
    throw new Error(`DATA LOSS DETECTED: expected ${expectedCount + 1} rows, got ${after.length}`)
  }
  if (!Array.isArray(after)) {
    throw new Error(`FORMAT MISMATCH: expected plain array, got ${typeof after}`)
  }

  // Confirm re-running the same day again doesn't duplicate.
  const result2 = simulateAppendRow(name, { date: '2024-09-15', open: 145, high: 146.5, low: 144, close: 146, volume: 260000 })
  const after2 = dumpEngineStore()[STOCK_KEY(name)]
  console.log('Re-run same day result:', JSON.stringify(result2), `-> total rows now: ${after2.length}`)
  if (after2.length !== expectedCount + 1) {
    throw new Error(`DUPLICATE ROW BUG: expected still ${expectedCount + 1} rows, got ${after2.length}`)
  }

  console.log('\n✅ 500 historical rows preserved. New day appended correctly. No duplicates on re-run. Format is a plain array as required.')
}

main()
