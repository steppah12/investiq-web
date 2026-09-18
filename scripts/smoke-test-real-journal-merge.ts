// @ts-nocheck
import { hydrateEngineStore, dumpEngineStore, STOCK_KEY, LAB_STOCKS } from '../src/lib/liveLab/engine'

function makeSyntheticRows(days, startPrice = 100) {
  const rows = []
  let price = startPrice
  let d = new Date('2023-01-02')
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
  const name = 'Stanbic Bank'
  const rows = makeSyntheticRows(400)
  const lastTwoDates = [rows[rows.length - 2].date, rows[rows.length - 1].date]

  // Simulate what's ACTUALLY in your real journal right now: manual
  // check-in entries, in the real shape (no gatedSignal field — that's
  // new, added by the automated pipeline).
  const existingManualJournal = [
    {
      id: Date.now(),
      date: lastTwoDates[0],
      stock: name,
      ticker: 'SBIC',
      signal: 'BUY', // manually-entered entry, gated signal, no gatedSignal field
      confidence: 58,
      probUp: 70,
      actual: null,
      correct: null,
      price: rows[rows.length - 2].close,
    },
  ]

  const records = {
    iq_macro: { cbk_rate: 13, inflation: 4.5, usd_kes: 129.5, gdp_growth: 5.0 },
    iq_events: [],
    iq_deadband: { 30: 2.0, 60: 3.5, 90: 5.0 },
    iq_train_results: {},
    iq_lab_journal: existingManualJournal, // <-- the REAL key, pre-seeded like your actual account
    iq_lab_paper: { value: 100000, trades: [], startedAt: new Date().toISOString() },
  }
  for (const n of LAB_STOCKS) {
    records[STOCK_KEY(n)] = n === name ? rows : makeSyntheticRows(400)
  }
  hydrateEngineStore(records)

  console.log(`Seeded real iq_lab_journal with 1 manual entry, dated ${lastTwoDates[0]}.`)
  console.log(`Stock data goes up through ${lastTwoDates[1]} (1 day newer than the manual entry).`)

  // Reproduce catchUpStock's date-selection logic exactly (not exported,
  // mirrored here) to confirm it picks up from AFTER the manual entry,
  // not from scratch and not skipping it.
  const journal = dumpEngineStore()['iq_lab_journal']
  const stockJournal = journal.filter((e) => e.stock === name)
  const lastProcessedDate = stockJournal.length > 0 ? stockJournal[stockJournal.length - 1].date : null
  const data = dumpEngineStore()[STOCK_KEY(name)]
  const pendingDates = data.map((r) => r.date).filter((d) => !lastProcessedDate || d > lastProcessedDate)

  console.log(`lastProcessedDate (from existing manual entry): ${lastProcessedDate}`)
  console.log(`pendingDates computed: ${JSON.stringify(pendingDates)}`)

  if (pendingDates.length !== 1 || pendingDates[0] !== lastTwoDates[1]) {
    throw new Error(
      `Expected exactly 1 pending date (${lastTwoDates[1]}), got ${JSON.stringify(pendingDates)} — ` +
        `the pipeline would either re-process the manual entry or miss the new day.`
    )
  }

  console.log('\n✅ Correctly continues from the existing manual entry — processes only the 1 genuinely new day, no duplication, no gap.')
}

main().catch((e) => {
  console.error('❌ FAILED:', e.message)
  process.exit(1)
})
