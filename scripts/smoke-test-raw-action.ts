// @ts-nocheck
// Standalone test of deriveRawAction's logic (reproduced here since it's
// not exported from pipeline.ts — this mirrors the exact function body).
function deriveRawAction(pred) {
  const probUp = pred.probUp || 0
  const probDown = pred.probDown || 0
  const probFlat = pred.probFlat || 0
  if (probUp === 0 && probDown === 0 && probFlat === 0) return { action: 'HOLD', confidence: 0 }
  if (probUp >= probDown && probUp >= probFlat) return { action: 'BUY', confidence: probUp }
  if (probDown >= probUp && probDown >= probFlat) return { action: 'SELL', confidence: probDown }
  return { action: 'HOLD', confidence: probFlat }
}

const cases = [
  { name: 'clear BUY', pred: { probUp: 0.7, probDown: 0.2, probFlat: 0.1 }, expect: 'BUY' },
  { name: 'clear SELL', pred: { probUp: 0.1, probDown: 0.75, probFlat: 0.15 }, expect: 'SELL' },
  { name: 'clear HOLD', pred: { probUp: 0.2, probDown: 0.2, probFlat: 0.6 }, expect: 'HOLD' },
  { name: 'UP/DOWN tie -> BUY wins (first branch)', pred: { probUp: 0.4, probDown: 0.4, probFlat: 0.2 }, expect: 'BUY' },
  { name: 'all zero (missing fields) -> HOLD', pred: {}, expect: 'HOLD' },
  { name: 'UP barely edges FLAT', pred: { probUp: 0.34, probDown: 0.33, probFlat: 0.33 }, expect: 'BUY' },
]

let failures = 0
for (const c of cases) {
  const result = deriveRawAction(c.pred)
  const pass = result.action === c.expect
  console.log(`${pass ? '✅' : '❌'} ${c.name}: got ${result.action} (confidence ${result.confidence}), expected ${c.expect}`)
  if (!pass) failures++
}

if (failures > 0) {
  console.error(`\n❌ ${failures} case(s) failed`)
  process.exit(1)
}
console.log('\n✅ All deriveRawAction cases behave as expected')
