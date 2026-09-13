// @ts-nocheck
// Standalone smoke test — NOT part of the app, just verifying the extracted
// engine code actually runs end-to-end without crashing, using synthetic
// data (since we don't have real historical CSVs in this environment).
import {
  hydrateEngineStore,
  buildFeaturesForStock,
  trainModelsGuarded,
  walkForwardBacktest,
  generatePredictionGuarded,
  saveModelWeights,
  STOCK_KEY,
  loadStockData,
} from '../src/lib/liveLab/engine'

function makeSyntheticRows(days, startPrice = 100) {
  const rows = []
  let price = startPrice
  let d = new Date('2023-01-02')
  let count = 0
  while (count < days) {
    const day = d.getDay()
    if (day !== 0 && day !== 6) {
      const drift = (Math.sin(count / 15) * 0.4) + (Math.random() - 0.5) * 1.5
      price = Math.max(1, price + drift)
      const high = price + Math.random() * 1.2
      const low = price - Math.random() * 1.2
      const volume = Math.floor(50000 + Math.random() * 400000)
      rows.push({
        date: d.toISOString().split('T')[0],
        open: price,
        high,
        low,
        close: price,
        volume,
      })
      count++
    }
    d.setDate(d.getDate() + 1)
  }
  return rows
}

async function main() {
  const name = 'Stanbic Bank'
  const rows = makeSyntheticRows(500)
  console.log(`Generated ${rows.length} synthetic trading days for ${name}`)

  hydrateEngineStore({
    [STOCK_KEY(name)]: { name, rows },
    iq_macro: { cbk_rate: 13, inflation: 4.5, usd_kes: 129.5, gdp_growth: 5.0 },
    iq_events: [],
    iq_deadband: { 30: 2.0, 60: 3.5, 90: 5.0 },
  })

  console.log('Step 1: buildFeaturesForStock...')
  const features = buildFeaturesForStock(rows, name, null, null, { [name]: { name, rows } })
  console.log(`  -> features array length: ${features?.length}`)

  console.log('Step 2: trainModelsGuarded (horizon=30)...')
  const g30 = trainModelsGuarded(rows, features, 30, null, null)
  console.log(`  -> model trained: ${!!g30?.model}`)

  console.log('Step 3: walkForwardBacktest...')
  const backtest = walkForwardBacktest(rows, features, 30, 5, name, true)
  console.log(`  -> avgAccuracy: ${backtest?.avgAccuracy}`)

  console.log('Step 4: saveModelWeights...')
  const models = { m30: g30.model, m60: null, m90: null, backtest, trainedAt: new Date().toISOString() }
  if (g30.model) saveModelWeights(name, models, g30.model.norm)
  console.log('  -> saved OK')

  console.log('Step 5: generatePredictionGuarded...')
  const updated = { name, rows, features, models }
  const pred = generatePredictionGuarded(updated, null, { [name]: updated })
  console.log(`  -> prediction:`, JSON.stringify(pred))

  console.log('\n✅ ALL STEPS COMPLETED WITHOUT THROWING')
}

main().catch((e) => {
  console.error('\n❌ SMOKE TEST FAILED:', e)
  process.exit(1)
})
