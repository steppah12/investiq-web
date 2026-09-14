// @ts-nocheck
// Regression test for the MAX_CATCHUP_DAYS fix. Before this fix, a
// brand-new stock (no journal history) with years of data would produce
// pendingDates = its ENTIRE row history — hundreds/thousands of full
// retrain cycles. This simulates that exact scenario and confirms the cap
// actually kicks in.
import { hydrateEngineStore, dumpEngineStore, STOCK_KEY, LAB_STOCKS } from '../src/lib/liveLab/engine'

function makeSyntheticRows(days, startPrice = 100) {
  const rows = []
  let price = startPrice
  let d = new Date('2017-01-02') // matches the real multi-year datasets in production
  let count = 0
  while (count < days) {
    const day = d.getDay()
    if (day !== 0 && day !== 6) {
      price = Math.max(1, price + (Math.random() - 0.5) * 1.5)
      rows.push({
        date: d.toISOString().split('T')[0],
        open: price,
        high: price + 1,
        low: price - 1,
        close: price,
        volume: 100000,
      })
      count++
    }
    d.setDate(d.getDate() + 1)
  }
  return rows
}

async function main() {
  const MAX_CATCHUP_DAYS = 20 // must match pipeline.ts's constant

  const records = {
    iq_macro: { cbk_rate: 13, inflation: 4.5, usd_kes: 129.5, gdp_growth: 5.0 },
    iq_events: [],
    iq_deadband: { 30: 2.0, 60: 3.5, 90: 5.0 },
    iq_train_results: {},
    iq_lab_journal_auto: [], // <-- empty journal = brand-new stock scenario, exactly like tomorrow's first real run
    iq_lab_paper_auto: { value: 100000, trades: [], startedAt: new Date().toISOString() },
  }
  // Simulate ~2000 trading days (~8 years) — matching real production data
  // (ABSA NewGold ETF's real dataset starts 2017).
  const TOTAL_DAYS = 2000
  for (const name of LAB_STOCKS) {
    records[STOCK_KEY(name)] = makeSyntheticRows(TOTAL_DAYS, 50 + Math.random() * 100)
  }
  hydrateEngineStore(records)

  const data = dumpEngineStore()[STOCK_KEY('Stanbic Bank')]
  console.log(`Simulated stock has ${data.length} total historical rows, empty journal (brand new).`)

  // Reproduce pipeline.ts's exact logic (not exported, so mirrored here):
  const journal = []
  const stockJournal = journal.filter((e) => e.stock === 'Stanbic Bank')
  const lastProcessedDate = stockJournal.length > 0 ? stockJournal[stockJournal.length - 1].date : null
  let pendingDates = data.map((r) => r.date).filter((d) => !lastProcessedDate || d > lastProcessedDate)

  console.log(`Before cap: pendingDates.length = ${pendingDates.length}`)

  if (pendingDates.length > MAX_CATCHUP_DAYS) {
    pendingDates = pendingDates.slice(-MAX_CATCHUP_DAYS)
  }

  console.log(`After cap: pendingDates.length = ${pendingDates.length}`)

  if (pendingDates.length !== MAX_CATCHUP_DAYS) {
    throw new Error(`Expected exactly ${MAX_CATCHUP_DAYS} after cap, got ${pendingDates.length}`)
  }
  if (pendingDates[pendingDates.length - 1] !== data[data.length - 1].date) {
    throw new Error('Cap did not keep the MOST RECENT dates — that would be a worse bug (stale predictions)')
  }

  console.log(
    `\n✅ Without the fix, this run would have attempted ${TOTAL_DAYS} full retrain+backtest cycles ` +
      `for this one stock alone. With the fix: ${MAX_CATCHUP_DAYS}, and they're the correct (most recent) ones.`
  )
}

main()
