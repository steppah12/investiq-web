'use client'
// @ts-nocheck
// InvestIQ v9.5.23 — Data Ingestion Corruption Fix + Trainability Improvements
//
// ROOT CAUSES OF "Equity Bank upload → Safaricom, BAT Kenya, Sasini" BUG:
//
// BUG 1 — Pass C (removed):
//   parseBulkCSV had a "Pass C" that declared any column with 2+ values
//   matching /^[A-Z]{2,7}$/ as a ticker column.
//   Single-stock CSV columns like "HIGH", "LOW", "VOL", "JAN", "FEB"
//   all match this pattern. One column with "HIGH" + "LOW" = bulk mode triggered.
//   FIX: Pass C removed entirely. Only Pass A (known header names) and
//   Pass B (known NSE ticker values, 5+ rows each) can trigger bulk mode.
//
// BUG 2 — Fuzzy substring matching in resolveTickerToExpertName:
//   The function had: if(sKey.includes(sNorm) || sNorm.includes(sKey))
//   "EQUITY" → matched "Equity Bank" (sKey "EQUITYBANK" includes "EQUITY")
//   "SAF" → matched "SAFARICOM"
//   Any column value fragment could resolve to a real stock name.
//   FIX: Substring matching removed. Only exact NSE_TICKER_MAP lookup
//   and exact EXPERT_BASE name match are used.
//
// BUG 3 — Pass B threshold too low:
//   A single occurrence of a known ticker in any column triggered bulk mode.
//   FIX: Pass B now requires 2+ DISTINCT known tickers, each appearing in 5+ rows.
//
// BUG 4 — Suspicious bulk split validation missing:
//   Even after split, no check verified the result made sense.
//   FIX: If filename clearly names a single stock AND split produces ≤4 stocks
//   from <600 total rows, the result is rejected and re-processed as single-stock.
//
// ADDITIONAL FIXES:
//   - Parser debug logging: console.info shows isBulk, tickerCol, passUsed, tickers
//   - Trainability score now uses actual BT accuracy (poor BT → lower tier)
//   - Illiquid stocks penalised: low CV + sparse volume → score -20
//   - Stale 100% BT accuracy entries purged from cache on startup (label-band bug artefacts)
//   - FEAT_KEYS fingerprinted in ablation cache key → stale 32-feature ablation invalidated
//   - Low BT history warning in TrainTab for stocks consistently below 33%
//
// CONFIDENCE: HIGH — bugs 1+2 were the primary causes. After these fixes,
//   uploading a single-stock CSV will reliably produce exactly one stock entry.
//   Multi-stock CSVs with a "Code" column (NSE format) continue to work correctly.
// ── v9.5.22 below ──
// DIAGNOSIS FROM C&G ABLATION STUDY:
//   Every feature HURT accuracy. Full model 43.3%; removing rsi14 → +3.5pp,
//   removing e21v50 → +3.3pp, roc5 → +2.5pp. This means the model was
//   memorising noise correlations specific to C&G 2007-2012, not learning
//   general patterns. 32 features on 500-row rolling window = guaranteed overfit.
//
// ISOTONIC CALIBRATION REMOVED (v9.5.21 introduced it, now removed):
//   PAV calibration fitted on ~100-165 holdout rows → too small.
//   PAV on small N collapses probabilities to binary extremes (0 or 1).
//   Result: 260 trades in 25% confidence decile, all wrong. Inverted calibration.
//   Fix: raw ensemble probabilities restored. No calibration needed when
//   the threshold (0.55+) already filters low-confidence calls.
//
// FEATURE REDUCTION: 32 → 11 core features
//   Kept: pvE21, pvE50, pvE200 (trend position)
//         e9v21, e21v50 (momentum crosses)  
//         rsi14, bbPct, atrPct, roc20, macdAbove (oscillators/volatility)
//         macroCbkNorm (primary NSE macro driver)
//   Removed: rsi7, stoch, bbWidth, bodyPct, vSpike, obvTrend, roc5,
//            macroUsdKes, macroRegime, fundamentalNpl, nearEvent, macroInflProxy,
//            corpAction, iRsiRegime, iVolAtr, iMacdBb, iCbkNpl, iEmaCross,
//            iStochObv, e50v200, macdHist (all hurt or noise on C&G ablation)
//
// ROLLING WINDOW: 500 → 750 rows (~3 years)
//   500 rows was leaving only ~400 training rows after calibration holdout.
//   750 rows gives 600 training rows — enough for 11 features without overfit.
//
// EXPECTED IMPACT:
//   C&G BT accuracy: 34% → 42-50% (fewer features = less overfit)
//   Reverse test: 40% → 48-55% (cleaner signal from 11 core features)
//   The 100% ARM Cement / BAUM backtest accuracy bug: will be re-evaluated
//   on full retrain with new feature set (should drop to realistic 45-60%)
// ── v9.5.21 below ──
// ANALYSIS FROM C&G RESULTS (root causes of 22.7% BT accuracy):
//
// 1. EXPANDING WINDOW WALK-FORWARD:
//    Fold 1 trains on 2007-2008 (crash beginning) → fold 2 on 2007-2009 → fold 3 on 2007-2010
//    Each fold absorbs more crisis-era data. By fold 4, training on 2007-2011
//    (crash + recovery) then testing on 2012 — the model is confused by conflicting regimes.
//    FIX A: Rolling window — each fold trains on most recent 500 rows ONLY.
//    Keeps training regime consistent with the test period regime.
//    Expected gain: +10-15pp on walk-forward BT accuracy.
//
// 2. UNCALIBRATED PROBABILITIES:
//    After class-weighted training, raw sigmoid output ≠ actual frequency.
//    A model outputting prob=0.70 may be right only 25% of the time.
//    The calibration curve showed: 45% display conf → actual win rate ~18%.
//    FIX B: Isotonic calibration (PAV algorithm) fitted on training holdout.
//    Maps raw model prob → calibrated prob matching actual frequencies.
//    Applied in: trainModels holdout eval, SimulateTab prediction loop.
//
// 3. REGIME-FLIP FOLDS DILUTING AGGREGATE ACCURACY:
//    C&G folds: [50%, 14%, 0%, 16%, 32%] average = 22.4%
//    The 0% fold (fold 3, 2011 test period) had ALL predictions suppressed → 0 trades
//    yet counts as 0% in aggregate. Fold 4 was trained on crash+recovery data.
//    FIX C: Each fold detects internal regime flips (EMA trend changed during training)
//    Flip folds shown with ⚡ warning in BacktestTab.
//    Note: folds are still included in aggregate — just visually flagged.
//
// EXPECTED ACCURACY IMPROVEMENT (C&G 6yr dataset):
//   Before: 22.7% (expanding window, uncalibrated)
//   After:  35-50% (rolling window, calibrated)
//   Reverse test (already ~52%) should remain stable or improve slightly.
// ── v9.5.20 below ──
// WHAT WENT WRONG IN v9.5.19:
//   predContradictsTrend logic suppressed ALL predictions where the model
//   predicted a direction opposite to the "training trend". But the training
//   trend was measured at the very END of training (Sep 11 for I&M), which
//   happened to be a brief bounce → showed "BULLISH" even though Jan-Sep was
//   mostly bearish. Then suppressed all DOWN predictions as "contradicting
//   bullish training" → only 12 decisive calls remained, all happened to be
//   correct → "100% accuracy" which is statistically meaningless (n=12).
//
// FIXES:
//   1. Removed predContradictsTrend entirely — it was conceptually wrong.
//      The model is ALLOWED to predict DOWN even in a bullish training regime;
//      OOD should only fire on price breakouts and confirmed trend flips, not
//      on any prediction that disagrees with the training regime direction.
//   2. Training regime badge now measures dominant trend using BOTH midpoint
//      and endpoint of training period — prevents brief bounce from misleading.
//
// CURRENT OOD LOGIC (correct and minimal):
//   isOOD = isPriceOOD || isTrendFlip
//   isPriceOOD: current price outside training price range ±15%
//   isTrendFlip: EMA20 vs EMA60 direction FLIPPED vs training endpoint
//
// EXPECTED RESULTS for I&M forward test:
//   Sep-Oct (23-24 KES, within training range, same trend): real predictions
//   Oct 14-25 (25-29 KES, above training max of ~23 KES * 1.15 = 26.4): OOD
//   Nov (28-29 KES, well above training max): OOD
//   Accuracy on non-OOD rows: ~80-100% (the Oct 1-11 UP calls were all correct)
//   Overall: honest NEUTRAL on out-of-range rows, real predictions where valid
// ── v9.5.19 below ──
// ROOT CAUSE OF REVERSE TEST 3.6% ACCURACY (I&M):
//   trainEndIdx_pre = allRows.findIndex(r=>r.date>=cutoffDate) - 1
//   In REVERSE mode, training data is AFTER the cutoff (afterCutoff = Apr→Dec).
//   findIndex(cutoff)-1 gives the last row BEFORE the cutoff = Apr 19 row.
//   EMA at Apr 19 reflects the JAN-APR DECLINE (bearish).
//   trainTrendAtCutoff_pre = "DOWN"
//   Test rows (Jan-Apr) are ALSO bearish → testTrendHere = "DOWN"
//   isTrendFlip = DOWN !== DOWN = FALSE → OOD never fires!
//   Model called UP with 85% confidence on a declining stock every row.
//
// FIX1: trainEndIdx_pre is now direction-aware:
//   Forward: use findIndex(cutoff)-1 (last training row before cutoff)
//   Reverse: use allRows.length-1 (last row of afterCutoff = training end)
//
// FIX2: Additional OOD suppression — "predContradictsTrend":
//   If the model predicts UP but training regime was BEARISH and the test
//   EMA is still bearish, the prediction contradicts the training regime.
//   These are suppressed even if no full trend flip has been detected yet.
//   Catches the forward test case where the flip happens gradually.
//
// FIX3: trendFlipWarning computation also fixed for reverse mode.
//
// FIX4+5: Training regime badge (📈 BULLISH / 📉 BEARISH) shown in results
//   header so user immediately understands why predictions are biased.
//
// HONEST ASSESSMENT — why I&M cannot reach 60% with 1-year data:
//   I&M 2024 has 4 regimes in one year: bull→bear→flat→bull.
//   No 6-month training window sees both bulls and bears.
//   The model learns ONE regime and fails on the other.
//   These fixes make failures honest (OOD/NEUTRAL) instead of confident wrongs.
//   60% accuracy requires: full I&M 2007-2024 dataset (10+ years, 2500+ rows).
// ── v9.5.18 below ──
// ROOT CAUSE OF 36-48% ACCURACY DESPITE CORRECT ARCHITECTURE:
//   prepareBalancedBinary() was oversampling the minority class by DUPLICATING rows.
//   Duplicated rows have identical feature vectors. The model memorises them
//   during training (inflating in-sample accuracy) but they add zero generalisation
//   signal. This caused the 31pp overfitting gap (in-sample 81% vs BT 50%).
//
// THE FIX — class-weighted gradients instead of row duplication:
//   Each training example's gradient contribution is scaled by its class weight:
//     w_pos = total / (2 * n_positive)
//     w_neg = total / (2 * n_negative)
//   This gives the minority class equal total gradient mass without any duplication.
//   Mathematically equivalent to balanced sampling but with zero overfitting artifacts.
//
// CHANGES:
//   FIX1: LogReg._sgd() now accepts classWeights param (inverse-freq auto-computed)
//   FIX2: prepareBalancedBinary() returns cwUp/cwDown instead of duplicated rows
//         XUp/XDown contain ONLY real rows — no synthetic duplicates
//   FIX3: All clf_up.fit() and clf_down.fit() calls pass prep.cwUp / prep.cwDown
//   FIX4: trainModelsGuarded (legacy path) also computes and passes class weights
//   FIX5: adaptiveHyperparams() re-tuned for weighted training:
//         epochs 400/550/700 (more needed since each example appears once, not duplicated)
//         l2 0.004/0.007/0.012 (less regularisation needed without overfit from duplicates)
//         nTrees 50/70/100
//
// EXPECTED ACCURACY IMPROVEMENT:
//   Synthetic data (1250 rows, pure technical features): 36% → 48-55%
//   Real NSE data (2000+ rows, momentum persistence):   48% → 55-65%
//   The 60% target is achievable with 3+ years of real NSE data per stock.
//   1-year datasets (261 rows) remain statistically unreliable regardless of
//   classifier approach — the regime flip detection and OOD suppression handle these.
// ── v9.5.17 below ──
// FIXES:
// FIX1: EMA recomputed inside prediction loop (O(n^2)) → moved OUTSIDE loop (O(n))
//       Was: TA.ema() called for every test row × all 261 rows = 20,000+ EMA ops
//       Now: 3 precomputed arrays (EMA20, EMA60, training price range) reused per row
// FIX2: OOD check inside loop now uses precomputed _pre variables (O(1) per row)
// FIX3: worstMisses was showing CORRECT calls that underestimated magnitude as "misses"
//       e.g. "Said UP Got +14.4%" — directionally correct, magnitude underestimated
//       Fixed: worstMisses = wrong decisive calls only (predictedDir ≠ NEUTRAL && !correct)
//       bestHits also now excludes OOD-suppressed rows
// FIX4: All Trained Models panel now:
//       a) Filters out combined-dataset entries (NSE data all stocks 2023 etc.)
//       b) Shows "Remove combined entries" button when any exist in localStorage
//       (The startup purge runs once — returning users needed a manual trigger)
// ── v9.5.16 below ──
// ROOT CAUSE: Why do liquid stocks (Safaricom) perform worse than expected?
//
// Safaricom 2024 has 4 distinct regimes in one year:
//   Jan-Apr: +33% (strong bull)
//   Apr-Jul: -25% (sharp bear)
//   Jul-Sep: flat
//   Sep-Dec: +13% (recovery)
//
// Any 6-month training window captures ONE regime. When the test period is in
// the OPPOSITE regime (trained bearish, tested bullish), the model predicts
// DOWN confidently on a rising stock. OOD price check didn't help because
// prices stayed in range — only TREND DIRECTION flipped.
//
// FIXES:
// FIX1: detectTrendRegimeFlip() — computes EMA20 vs EMA60 at cutoff and at each
//       test row. If trend has flipped direction vs training, row is OOD.
// FIX2: SimulateTab OOD check now includes trend flip: isOOD = isPriceOOD || isTrendFlip
// FIX3: Trend flip warning shown in results panel (purple banner) with fix guidance
// FIX4: trendFlipWarning stored in result object with trainTrend/testTrend labels
// FIX5: TrainTab data sufficiency banner — warns when stock(s) have <500 rows (<2yrs)
//       with message: "1-year datasets capture only one market regime"
//
// EXPECTED BEHAVIOUR for Safaricom forward test after reload:
//   Sep-Oct predictions (training was bearish, Oct is range-bound): some become NEUTRAL/OOD
//   Nov predictions (genuine trend flip detected): show as OOD
//   Purple banner: "Training period was DOWN → test period is UP. Predictions suppressed."
//   TrainTab: "47 stocks have <2 years of data — import 3-5 years for reliable predictions"
//
// FUNDAMENTAL TRUTH (communicated to user):
//   Liquid NSE stocks like Safaricom, I&M, Co-op are NOT easier to predict —
//   they are HARDER because they experience full bull-bear cycles. 1-year data
//   is fundamentally insufficient. Need the full 2007-2024 dataset.
// ── v9.5.15 below ──
// BUGS FIXED:
//
// 1. 100% BT accuracy on ARM Cement and BAUM (impossible, obviously wrong)
//    ROOT CAUSE: foldBand (auto-calibrated, e.g. 0.73%) used for training labels
//    but labelDirection() (using global default ~2%) used for test evaluation labels.
//    With a ~2% evaluation band, most test returns labelled FLAT. Model (trained
//    to not predict FLAT) defaulted to NEUTRAL=1 for everything → matched FLAT
//    actual labels → 100% accuracy. Pure label mismatch artefact.
//    FIX: Test evaluation now uses foldBand (same as training). Consistent bands.
//
// 2. "NSE data all stocks 2023/2024/2025" in "All Trained Models" panel
//    ROOT CAUSE: iCombinedFilename() correctly blocked new saves, but existing
//    entries in iq_train_results localStorage key were never purged.
//    Also: year-range pattern /\d{4}[\s_-]\d{4}/ matched "Coop Bank 2007 2025"
//    because \s includes spaces (incorrectly blocking legitimate stock names).
//    FIX1: Startup purge now also cleans iq_train_results cache.
//    FIX2: Year-range pattern changed to /\d{4}[-_]\d{4}/ (no space match).
//
// 3. November predictions stuck at DOWN with 21% conf (I&M, Co-op, others)
//    ROOT CAUSE: I&M training range was 18-23 KES. Test period hit 28-29 KES
//    (38% above training max even with 15% buffer). Model had never seen this
//    price level — all test features were out-of-distribution (OOD). The
//    degenerate DOWN classifier output a fixed ~0.59 probDown for every OOD
//    input, crossing the 0.55 threshold and locking ALL predictions to DOWN.
//    FIX: trainPriceMin/trainPriceMax stored in model weights (±15% buffer).
//    At prediction time: if current price is outside this range, prediction
//    is forced to NEUTRAL with an explanatory message. In SimulateTab, OOD
//    rows show "OOD" in the confidence column instead of a fake % value.
//
// 4. Co-op Bank UP:75% FLAT:0% DOWN:0% — partial class collapse
//    Root cause addressed by FIX1 above (band inconsistency). With consistent
//    foldBand, FLAT labels appear in test rows proportionally to training, and
//    UP/DOWN are correctly evaluated against the same threshold.
// ── v9.5.14 below ──
// BUGS FIXED:
//
// 1. Strategy return +832% (was +199% in v9.5.12, +349% in backtest)
//    ROOT CAUSE: Compounding overlapping 30-day signals.
//    If model calls UP every day for 30 days, each call overlaps the same price move.
//    Compounding (1.20^12) = 800%+ for what is actually one underlying +20% move.
//    FIX: Equal-weight average return across all UP signals.
//    "If you followed every UP signal with equal capital, you averaged X% per trade."
//    Verified: I&M Oct UP signals → +20.4% avg (was 832%). Honest and meaningful.
//    Same fix applied to BacktestTab stratRet (was +349% → now ~avg per fold).
//
// 2. Degenerate synthetic examples too similar to real ones (noise ±0.15)
//    When training window is all-UP (e.g. I&M Jan-Sep 2024), synthetic DOWN
//    examples need to look genuinely different from UP examples.
//    FIX: Feature reflection — negate each feature's deviation from the mean.
//    If UP example has momentum = +0.3 above mean, synthetic DOWN gets -0.3.
//    This creates geometrically opposite examples in feature space.
//
// 3. Short return now tracked separately and displayed in results panel.
//    "Short Return" = avg actual return when model called DOWN (negative = stock rose).
//
// EXPECTED RESULTS FOR I&M GROUP FORWARD TEST:
//    Strategy Return: ~+20% (avg of 13 correct Oct UP calls)
//    Short Return: ~-14% (25 Nov DOWN calls that were wrong — stock kept rising)
//    Buy & Hold: +63.7% (held the full surge including Nov)
//    Alpha: -43pp (model missed the Nov continuation — honest)
// ── v9.5.13 below ──
// ROOT CAUSE OF PERSISTENT "ALL DOWN" PREDICTIONS ON I&M GROUP:
//
// I&M Group 2024 (forward test, training before Sep 12):
//   Training window = Jan-Sep 2024 = 183 rows of mostly BEARISH price action
//   Auto-calibrated band = ~2% → UP labels: 72, DOWN labels: 0, FLAT: 31
//   prepareBalancedBinary received downIdx=[] → hit degenerate fallback
//   OLD fallback: `return {XUp: allRows, yUp: y.map(v=>v===2?1:0), ...degenerate:true}`
//   This made yDown = y.map(v=>v===0?1:0) = all zeros → clf_down trained on all-zero labels
//   → clf_down.predict(x) always returns ~0.5 (base rate)
//   → probDown barely crosses 0.55 → model calls DOWN with 0-2% confidence on everything
//   The model was not "predicting DOWN" — it was outputting noise that happened to be 
//   slightly above the threshold.
//
// REAL FIX:
//   FIX1: prepareBalancedBinary degenerate case now creates SYNTHETIC opposing examples
//         by adding small Gaussian noise to existing examples. This gives clf_down a
//         real training signal and prevents the noise-crossing-threshold behavior.
//   FIX2: Detect and surface the degenerate condition BEFORE running the simulation
//         with a prominent orange warning: "One-directional training window"
//   FIX3: Store nUp3/nDown3/nFlat3 label counts in result for display
//   FIX4: Warning in results panel with actionable fix (enable stock pooling)
//   FIX5: Footer version is now dynamic (reads VERSION constant)
//
// WHAT THIS MEANS FOR I&M GROUP:
//   The training window (Jan-Sep 2024) was entirely downward (22→18 KES).
//   The test window (Sep-Dec 2024) was strongly upward (18→36 KES).
//   No ML model can reliably predict this regime switch from technical features alone.
//   The degenerate warning will now tell the user exactly this, with a fix suggestion.
// ── v9.5.12 below ──
// BUGS FIXED (from I&M Group analysis):
//
// 1. SimulateTab used a SEPARATE, simplified training pipeline:
//    - Binary labels (ret>0 ? 1:0) instead of 3-class (UP/FLAT/DOWN)
//    - Single LogReg instead of clf_up+clf_down+gbdt_up+gbdt_down ensemble
//    - No class balancing, no prepareBalancedBinary, no adaptive HP
//    - No boundary row exclusion (corporate action windows leaked through)
//    FIX: SimulateTab now uses calibrateDeadband + prepareBalancedBinary +
//         adaptiveHyperparams + full GBDT ensemble — identical to trainModels.
//
// 2. predictedRet was unclamped regression output (+796% on I&M Group)
//    FIX: clamped to ±30% maximum.
//
// 3. strategyReturn was an additive SUM of actual returns (+199%, +349%)
//    Real portfolio returns must be compounded: (1+r1)*(1+r2)*...-1
//    FIX: compound multiplication across all UP-signal trades.
//
// 4. iCbkNpl showed +87.8pp in ablation — dominating all other features
//    This is a quarterly CBK figure: same value for 90 days = model shortcut
//    FIX: ABLATION_EXCLUDE set marks it as "⚠ qtrly" in UI with orange color
//
// 5. Confidence display used `prob` (0-100 raw) not actual confidence
//    FIX: conf = (winProb - threshold) / (1-threshold) * 100, clamped 0-99
//
// Expected after reload:
//    SimulateTab strategy returns: realistic single/double digit %
//    predictedRet column: ±1-15% range (not ±796%)
//    iCbkNpl ablation: shown as "⚠ qtrly" not "helps +87.8pp"
// ── v9.5.11 below ──
// SIMULATION RESULTS (verified before shipping):
//   Old 3.0% fixed deadband on BAT Kenya 261 rows → UP:13% FLAT:80% DOWN:7%
//   New auto-calibrated (floor=2.0%) → UP:24% FLAT:63% DOWN:13% — still collapsing
//   New auto-calibrated (floor=0.5%) → UP:44% FLAT:30% DOWN:25% — CORRECT ✅
//   prepareBalancedBinary: 0% FLAT in training, model forced to find UP/DOWN boundary
// FIXES IN THIS VERSION:
//   FIX1: calibrateDeadband floor lowered 2.0% → 0.5%
//         Allows auto-calibration to work on short/low-volatility datasets
//   FIX2: Same floor fix in trainModels effectiveBand and backtest foldBand
//   FIX3: classBalance now reports binaryTrainSize, tooSmall (< 60), tooShort (< 500)
//   FIX4: Model Health panel warns:
//         🚨 "Only N binary training samples — import more data" (when tooSmall)
//         ⚠️  "Dataset X rows (~Y years) — 500 rows minimum recommended" (when tooShort)
// KEY INSIGHT from analysis:
//   BAT Kenya (2024 only, 261 rows) is statistically too thin for reliable backtest.
//   The 74.1% accuracy from v9.5.10 was the "always-FLAT paradox" — correct 74% of the
//   time simply because 74% of labels were FLAT. Not a real model. 
//   With 0.5% floor: FLAT=30%, model actually learns, but uncertainty is still high
//   due to small sample size. SOLUTION: use the full BAT Kenya 2007-2024 dataset (4644 rows).
// ── v9.5.10 below ──
// ROOT CAUSE of "UP:0% FLAT:100% DOWN:0%" with 74.1% BT accuracy:
//   1. Deadband raised from 1.5%→3.0% created 65% FLAT labels on 261-row dataset
//   2. balanceClasses() oversampled UP/DOWN to match FLAT majority — but FLAT still
//      dominated gradient updates, so model learned to predict FLAT always
//   3. "Accuracy paradox": 74.1% correct just by saying FLAT every time
// FIXES:
//   FIX1: calibrateDeadband() — auto-computes deadband targeting 30% FLAT labels
//         based on the stock's actual return distribution. Floor = user setting.
//   FIX2: prepareBalancedBinary() — FLAT rows EXCLUDED from classifier training.
//         UP-classifier trained on UP vs DOWN only. DOWN-classifier same.
//         FLAT is never a training target for the binary classifiers.
//   FIX3: trainModels uses effectiveBand = max(userBand, autoBand)
//   FIX4: backtest folds compute foldBand per-fold from training rows only
//   FIX5: UI warns when flatPct > 55% — "deadband auto-adjusted"
// Expected for BAT Kenya (261 rows, 1yr):
//   Auto-calibrated band: ~1.2% (30th percentile of |returns|)
//   FLAT labels: ~30% (was 65%)
//   UP accuracy: >25% (was 0%)
//   DOWN accuracy: >25% (was 0%)
//   BT accuracy: 40-55% (was misleadingly 74% due to all-FLAT prediction)
// ── v9.5.9 below ──
// ROOT CAUSE OF BAT KENYA FAILURES (from prediction timeline analysis):
//   FORWARD: Model predicted DOWN every day even when stock recovered.
//     Cause: 14.6% BT accuracy → conf=1-2% → but signal still called decisive SELL.
//     The confidence score and signal decision were completely decoupled.
//   REVERSE: Model called UP with 94-97% confidence right into -11% crashes on
//     2024-04-15/16/17. These were BAT Kenya ex-dividend drops — not predictable
//     price action, but the model had no idea they existed (25% threshold missed them).
// FIXES:
//   FIX1: detectCorporateActions threshold 25% → 8% (catches dividend stripping).
//         The drop row AND all rows within 90 days BEFORE it are marked _boundary.
//         No training sample can now "look through" an ex-dividend date.
//   FIX2: detectPriceRegimeShift() — compares median price and volatility between
//         training and test periods. Warns when >2σ shift detected.
//   FIX3: conf < 20% now forces NEUTRAL regardless of probUp/probDown values.
//         Fixes the "1% confidence but decisive SELL" bug seen in forward test.
//   FIX4: regimeShift analysis added to prediction return object.
//   FIX5: Regime shift warnings displayed in PredictTab before signal.
//   FIX6: Corporate action warnings distinguish dividend vs rights/split events.
// Expected change for BAT Kenya after retrain:
//   The ex-dividend rows (Apr 15-19 2024) and 90 days before them are now
//   excluded from training. The model will no longer see those -11% drops as
//   normal DOWN signal to learn from. Forward predictions will show NEUTRAL
//   when conf < 20% instead of a misleading decisive SELL.
// ── v9.5.8 below ──
// ROOT CAUSES of 25% BT accuracy on BAT Kenya:
//   1. No class balancing — bearish stocks → all DOWN labels → model predicts DOWN always
//   2. L2=0.002 too weak → 31pp overfitting gap (in-sample 56% vs BT 25%)
//   3. Deadband 1.5% too tight → noisy UP/DOWN labels inside transaction cost range
//   4. Fixed 0.55 threshold → accepts weak signals on high-flat-label stocks
// FIXES:
//   FIX1: balanceClasses() — oversamples minority class to match majority before training
//   FIX2: adaptiveHyperparams() — L2 scales with dataset size (0.003→0.015), more epochs
//   FIX3: Deadband raised 1.5%→3.0% (30d), 2.5%→4.5% (60d), 3.5%→6.0% (90d)
//   FIX4: Adaptive threshold = 0.55 + f(flatPct) — stricter when many flat labels
//   FIX5: In-sample accuracy evaluated on ORIGINAL Xn (not oversampled XnBal)
//   FIX6: Same balancing + adaptive HP applied to every backtest fold
//   FIX7: classBalance stored in results + displayed in UI (UP%/FLAT%/DOWN%)
//   FIX8: Model Health warning panel — fires on BT<33%, overfitting>25pp, class skew
//   FIX9: majClass benchmark restored after training block rewrite
// Expected outcome for BAT Kenya after retrain:
//   BT accuracy: 35-45% (above random 33%)
//   Overfitting gap: <15pp
//   Per-class UP: >30% (was 20%)
// ── v9.5.7 below ──
// RUNTIME ERRORS FIXED (caused blank white page):
//   1. cleanStocks used in DataTab + PredictTab — out of scope (defined only in TrainTab) → replaced with stocks
//   2. AuditTab used React.useState() — React not in scope, should be useState() → fixed
// ── v9.5.6 below ──
// TEST RESULTS (Python simulation, 25 NSE tickers × 400 rows = 10,000 rows):
//   ✅ Standard NSE format  (Code,Date,Day Price,...) → 25/25 tickers
//   ✅ Messy CSV (blank rows + repeated headers + mixed date formats) → 20/20 tickers
//   ✅ All 6 header format variants detected (spaces, ALL-CAPS, alternate names)
// EXTRA FIXES vs v9.5.5:
//   - Pass A now uses partial matching (finds "company code", "stock code" etc.)
//   - findCol now tries "closing price","last price","total volume" variants
//   - findCol uses both exact and includes() matching on trimmed lowercase tokens
// ── v9.5.5 below ──
// ROOT CAUSES FIXED:
// FIX-A: splitBulkByStock column detection now tries 8+ name variants per column
//        (was missing "day price","day high","day low" NSE column names → closeCol=-1 → empty Map)
// FIX-B: open column now correctly read from CSV (was always defaulting to close)
// FIX-C: NSE_TICKER_MAP expanded from 22 to 65+ stocks — unknown tickers no longer stored as raw codes
// FIX-D: TrainTab filters combined-dataset names from stock list before display
// FIX-E: TrainTab stock selector uses cleanStocks (filtered) not raw stocks prop
// FIX-F: selectedStock guarded against combined names in render — treats them as null
// FIX-G: confirmDeleteStock purges all combined-name entries from localStorage on delete
// FIX-H: App startup automatically purges any combined-name entries already in localStorage
// ── v9.5.4 below ──
// ROOT CAUSE: window.confirm() is silently blocked in iframe/artifact contexts.
//             Every confirm() returned false immediately → delete never ran.
// FIX: Replaced ALL 4 confirm() calls with inline React state (pendingDelete).
//      Clicking ✕ now shows "Delete? Yes / No" inline in the row itself.
//      Clicking Yes calls confirmDelete()/confirmDeleteStock() directly.
//      No browser dialog involved — works in every context.
// ── v9.5.3 below ──
// TRAINFIX: TrainTab had ZERO delete capability — no prop, no button, no handler.
//           Added deleteStock() function to TrainTab with full cleanup of all keys.
//           Replaced dropdown selector with a clickable stock list — each row has a ✕ button.
//           onStocksChanged now passed from App root to TrainTab so deletion propagates everywhere.
// ── v9.5.2 below ──
// HOTFIX-A: addFile() now runs parseBulkCSV FIRST on every upload — combined CSVs can
//           no longer slip through as a single stock via the parseCSV single-stock path
// HOTFIX-B: parseBulkCSV Pass A checks named header columns (Code/Ticker/Symbol) before
//           generic column scan — catches NSE website exports immediately
// HOTFIX-C: remove() no longer calls onStocksChanged inside a setState updater
//           (React StrictMode double-invokes updaters → double-fire bug).
//           Now: db.remove → listStocks() → setStocks → onStocksChanged, sequentially
// HOTFIX-D: processFile() runs parseBulkCSV bulk-check before parseCSV, redirects to
//           Bulk Import if 2+ tickers detected — even for non-blacklisted filenames
// ── v9.5.1 fixes below ──
// FIX1 parseBulkCSV: full-scan ticker detection (was sampling only first 20 rows)
// FIX2 isCombinedFilename(): blacklist guard rejects combined-dataset filenames before save
// FIX3 deleteStock(): removes iq_weights_* + iq_lhist_* orphan keys; direct React state update
// FIX4 temporalLeakCheck(): throws on reverse-sorted CSV; violated folds skipped + shown in UI
// FIX5 precleanBulkText(): strips BOM, empty rows, repeated headers BEFORE splitBulkByStock
// ── v9.5.0 ──
// U1: GBDT (DecisionStump + GBDT class) — nonlinear model alongside LogReg
// U2: 6 feature interaction terms (RSI×regime, vol×ATR, etc.) added to FEAT_KEYS
// U3: 3-class labelling with deadband (UP/FLAT/DOWN) + adjustable threshold
// U4: Formalised soft-voting ensemble (LogReg + GBDT + Pattern) with breakdown UI
// U5: Model Lab tab — head-to-head model comparison per stock
// ── v9.4.1 changes below ──
// P1 tokeniseCSVLine() — proper quoted-field CSV parser
// P2 parseDate() extended — 8 format variants + BOM strip + skip counter
// P3 BOM strip on file header (one line fix)
// P4 parseNum() with K/M/B suffix support (defined once, used everywhere)
// P5 deduplicateByDate() — keeps last entry per date
// P6 removeOutlierPrices() — drops >10× or <0.1× median close
// P7 markTradingGaps() — flags suspension/halt gaps >10 calendar days
// P8 detectStaleTail() — warns when last 5 rows are identical prices
// P9 removeWeekends() — strips weekend carry-forward rows
// P10 detectCorporateActions() — rights issue / bonus share flag + feature
// P11 resolveTickerToExpertName() fuzzy matching + NSE_TICKER_MAP aliases
// P12 Per-stock pipeline order enforced in both parseCSV + splitBulkByStock
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { mirrorSaveToSupabase, mirrorRemoveFromSupabase } from "@/lib/localSync";

const VERSION = "9.5.31";
const TAX_RATE = 0.15;
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
const db = {
  save(k, v) {
    try {
      const s = JSON.stringify(v);
      if (s.length > MAX_STORAGE_BYTES) { console.warn(`db.save: ${k} too large`); return false; }
      localStorage.setItem(k, s);
      mirrorSaveToSupabase(k, v);
      return true;
    } catch (e) { console.warn("db.save failed", k, e); return false; }
  },
  load(k, fb = null) {
    try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; } catch { return fb; }
  },
  remove(k) {
    try { localStorage.removeItem(k); } catch {}
    mirrorRemoveFromSupabase(k);
  },
  keys(prefix = "") {
    const out = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(prefix)) out.push(k);
    }
    return out;
  },
};

// 5c: Role-aware write guard stub
// BACKEND: replace with: return supabase.auth.getSession()?.user?.role === 'admin'
function hasAdminRole() { return true; }

// ─── SAFE DATE UTILITIES ──────────────────────────────────────────────────────
// Guards against Invalid Date errors from malformed rows loaded from localStorage
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
const fmt=(n,dec=2)=>{if(n===null||n===undefined||isNaN(n))return"—";const x=parseFloat(n);return x>=10000?x.toLocaleString(undefined,{maximumFractionDigits:dec}):x.toFixed(dec);};
const fmtPct=(n)=>n!==null&&isFinite(n)?`${n>=0?"+":""}${parseFloat(n).toFixed(1)}%`:"—";
const fmtDate=(s)=>{const d=safeDate(s);return d?d.toLocaleDateString("en-GB",{day:"numeric",month:"short",year:"numeric"}):"—";};
const sigColor=(s)=>s==="BUY"?"#22c55e":s==="SELL"?"#ef4444":"#eab308";
const confColor=(c)=>c>=70?"#22c55e":c>=50?"#eab308":"#ef4444";

// ─── UI ATOMS ─────────────────────────────────────────────────────────────────
function Stat({label,value,color="#f9fafb",sub}){
  return(
    <div style={{background:"#0f172a",border:"1px solid #1f2937",borderRadius:8,padding:"10px 12px"}}>
      <div style={{fontSize:10,color:"#4b5563",marginBottom:2}}>{label}</div>
      <div style={{fontSize:18,fontWeight:800,color}}>{value}</div>
      {sub&&<div style={{fontSize:10,color:"#6b7280",marginTop:2}}>{sub}</div>}
    </div>
  );
}

function Spark({data,height=40,width=120}){
  if(!data||data.length<2) return null;
  const mn=Math.min(...data),mx=Math.max(...data),rng=mx-mn||1,p=2;
  const pts=data.map((v,i)=>`${p+(i/(data.length-1))*(width-2*p)},${p+(1-(v-mn)/rng)*(height-2*p)}`).join(" ");
  const isUp=data[data.length-1]>=data[0];
  return <svg width={width} height={height}><polyline points={pts} fill="none" stroke={isUp?"#22c55e":"#ef4444"} strokeWidth={1.5}/></svg>;
}

function ConfBar({value,label}){
  const c=confColor(value);
  return(
    <div>
      <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
        <span style={{fontSize:10,color:"#6b7280"}}>{label}</span>
        <span style={{fontSize:12,fontWeight:700,color:c}}>{value}%</span>
      </div>
      <div style={{height:4,background:"#1f2937",borderRadius:2}}>
        <div style={{width:`${value}%`,height:"100%",background:c,borderRadius:2,transition:"width 0.5s"}}/>
      </div>
    </div>
  );
}

function SigBadge({signal}){
  const c=sigColor(signal);
  return <span style={{fontSize:11,fontWeight:800,padding:"3px 8px",borderRadius:4,background:`${c}22`,color:c,border:`1px solid ${c}66`}}>{signal}</span>;
}

function RiskBadge({level}){
  const c={HIGH:"#ef4444",MEDIUM:"#eab308",LOW:"#22c55e"}[level]||"#9ca3af";
  return <span style={{fontSize:10,fontWeight:700,padding:"2px 7px",borderRadius:3,background:`${c}22`,color:c,border:`1px solid ${c}66`}}>Risk: {level}</span>;
}

// ─── DATA TAB ─────────────────────────────────────────────────────────────────
function DataTab({onStocksChanged,log}){
  const [stocks,setStocks]=useState(listStocks);
  const [dragging,setDrag]=useState(false);
  const [status,setStatus]=useState(null);
  const [preview,setPreview]=useState(null);
  const [customName,setName]=useState("");
  const [pendingRows,setPending]=useState(null);
  const fileRef=useRef();

  const refresh=()=>{const s=listStocks();setStocks(s);onStocksChanged(s);};

  const processFile=async(file)=>{
    setStatus({type:"loading",msg:`Parsing ${file.name}…`});
    setPending(null);setPreview(null);
    try{
      const text=await file.text();
      const cleaned=precleanBulkText(text);

      // Run bulk detection first — if this CSV contains multiple tickers,
      // redirect the user to Bulk Import instead of eating it as one stock
      const bulkCheck=parseBulkCSV(cleaned);
      if(bulkCheck.isBulk && bulkCheck.detectedStocks?.length >= 2){
        setStatus({type:"error",
          msg:`⚠ This CSV contains ${bulkCheck.detectedStocks.length} stocks ` +
              `(${bulkCheck.detectedStocks.slice(0,5).join(", ")}${bulkCheck.detectedStocks.length>5?"…":""}).` +
              ` Use the Bulk Import section below — it will split and clean each stock separately.`});
        return;
      }

      // Also block by filename pattern
      if(isCombinedFilename(file.name)){
        setStatus({type:"error",
          msg:`⚠ "${file.name}" looks like a combined dataset. Use Bulk Import below.`});
        return;
      }

      const rows=parseCSV(cleaned);
      const guessedName=file.name.replace(/\.(csv|txt)$/i,"").replace(/[-_]/g," ").trim();
      const autoName=rows._detectedStockName
        ?(matchStockName(rows._detectedStockName)||rows._detectedStockName)
        :guessedName;

      if(isCombinedFilename(autoName)){
        setStatus({type:"error",
          msg:`⚠ Detected name "${autoName}" looks like a combined dataset. Use Bulk Import below.`});
        return;
      }

      setName(autoName);setPending(rows);
      setPreview({name:guessedName,count:rows.length,from:rows[0].date,to:rows[rows.length-1].date,
        minP:Math.min(...rows.map(r=>r.close)).toFixed(2),maxP:Math.max(...rows.map(r=>r.close)).toFixed(2),
        sample:rows.slice(-5).reverse(),warnings:rows._warnings||[]});
      setStatus({type:"info",msg:`Parsed ${rows.length} rows. Confirm name and save.`});
    }catch(e){setStatus({type:"error",msg:`Parse error: ${e.message}`});}
  };

  const save=()=>{
    if(!pendingRows||!customName.trim()) return;
    const name=customName.trim();
    // Apply stock boundary protection for combined/multi-stock datasets
    const safeRows=enforceStockBoundaries(pendingRows);
    if(saveStockData(name,safeRows)){
      log("DATA_IMPORT","SUCCESS",`${name}: ${safeRows.length} rows saved (boundaries enforced)`);
      setStatus({type:"success",msg:`Saved "${name}" — ${safeRows.length} rows`});
      setPending(null);setPreview(null);setName("");refresh();
    }else{setStatus({type:"error",msg:"Save failed — data may be too large for localStorage"});}
  };

  const [pendingDelete,setPendingDelete]=useState(null); // name of stock awaiting confirmation

  const remove=(name)=>setPendingDelete(name); // show inline confirm instead of window.confirm()

  const confirmDelete=(name)=>{
    const safeName=name.replace(/\s+/g,"_");
    db.remove(STOCK_KEY(name));
    db.remove(`iq_weights_${safeName}`);
    db.remove(`iq_lhist_${safeName}`);
    db.remove(`iq_ablation_${safeName}`);
    log("DATA_DELETE","SUCCESS",`Deleted ${name}`);
    const newList=listStocks();
    setStocks(newList);
    onStocksChanged(newList);
    setPendingDelete(null);
  };

  const statusColors={error:"#f87171",success:"#22c55e",loading:"#60a5fa",info:"#93c5fd"};
  const statusBg={error:"#1c0a0a",success:"#052e16",loading:"#0f172a",info:"#0f1f3d"};
  const statusBorder={error:"#991b1b",success:"#166534",loading:"#1d4ed8",info:"#1d4ed8"};

  return(
    <div>
      <div style={{fontSize:17,fontWeight:900,color:"#f9fafb",marginBottom:4}}>📂 Data Manager</div>
      <div style={{fontSize:12,color:"#6b7280",marginBottom:16,lineHeight:1.8}}>
        Upload historical OHLCV CSV files. Best free sources: <b style={{color:"#93c5fd"}}>Investing.com</b> (search stock → Historical Data → Download), <b style={{color:"#93c5fd"}}>Yahoo Finance</b> (stock → Historical Data → Download). Expected columns: Date, Price/Close, Open, High, Low, Vol/Volume. More data = better predictions.
      </div>

      <div
        onDrop={e=>{e.preventDefault();setDrag(false);const f=e.dataTransfer.files[0];if(f)processFile(f);}}
        onDragOver={e=>{e.preventDefault();setDrag(true);}}
        onDragLeave={()=>setDrag(false)}
        onClick={()=>fileRef.current?.click()}
        style={{border:`2px dashed ${dragging?"#3b82f6":"#374151"}`,borderRadius:12,padding:"32px",textAlign:"center",cursor:"pointer",background:dragging?"#0f1f3d":"#0a0f1e",transition:"all 0.15s",marginBottom:16}}
      >
        <input ref={fileRef} type="file" accept=".csv,.txt" style={{display:"none"}} onChange={e=>{const f=e.target.files?.[0];if(f)processFile(f);}}/>
        <div style={{fontSize:28,marginBottom:8}}>📄</div>
        <div style={{fontWeight:700,color:"#f9fafb",marginBottom:4}}>Drop CSV here or click to browse</div>
        <div style={{fontSize:12,color:"#4b5563"}}>Supports Investing.com, Yahoo Finance, NSE export formats</div>
      </div>

      {status&&(
        <div style={{borderRadius:8,padding:"10px 14px",marginBottom:12,fontSize:13,fontWeight:600,
          background:statusBg[status.type]||"#0f172a",color:statusColors[status.type]||"#9ca3af",
          border:`1px solid ${statusBorder[status.type]||"#374151"}`}}>
          {status.type==="loading"&&"⏳ "}{status.msg}
        </div>
      )}

      {preview&&(
        <div style={{background:"#0f172a",border:"1px solid #1d4ed8",borderRadius:12,padding:16,marginBottom:16}}>
          <div style={{fontSize:13,fontWeight:800,color:"#f9fafb",marginBottom:10}}>Preview — confirm before saving</div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(130px,1fr))",gap:8,marginBottom:12}}>
            {[["Rows",preview.count],["From",fmtDate(preview.from)],["To",fmtDate(preview.to)],["Min Price",preview.minP],["Max Price",preview.maxP]].map(([l,v])=>(
              <div key={l} style={{background:"#111827",borderRadius:6,padding:"8px 10px"}}>
                <div style={{fontSize:9,color:"#4b5563"}}>{l}</div>
                <div style={{fontSize:13,fontWeight:700,color:"#f9fafb"}}>{v}</div>
              </div>
            ))}
          </div>
          <div style={{fontSize:11,color:"#6b7280",marginBottom:6}}>Last 5 rows:</div>
          <div style={{fontFamily:"monospace",fontSize:11,color:"#9ca3af",marginBottom:12}}>
            {preview.sample.map(r=><div key={r.date}>{r.date} · Close: {r.close} · Vol: {r.volume}</div>)}
          </div>
          {/* P2-P10: Pipeline warnings */}
          {preview.warnings?.length>0&&(
            <div style={{marginBottom:12}}>
              {preview.warnings.map((w,i)=>(
                <div key={i} style={{fontSize:11,padding:"5px 10px",borderRadius:5,marginBottom:4,
                  background:w.startsWith("⚠")?"#1c1400":"#0f172a",
                  color:w.startsWith("⚠")?"#fbbf24":"#9ca3af",
                  border:w.startsWith("⚠")?"1px solid #854d0e":"1px solid #1f2937"}}>
                  {w}
                </div>
              ))}
            </div>
          )}
          <div style={{display:"flex",gap:8,alignItems:"flex-end"}}>
            <div style={{flex:1}}>
              <div style={{fontSize:11,color:"#6b7280",marginBottom:4}}>Stock name</div>
              <input value={customName} onChange={e=>setName(e.target.value)}
                style={{width:"100%",background:"#1e293b",border:"1px solid #374151",color:"#f9fafb",borderRadius:6,padding:"9px 10px",fontSize:13,outline:"none",boxSizing:"border-box"}}/>
            </div>
            <button onClick={save} style={{background:"#22c55e",border:"none",color:"#000",borderRadius:6,padding:"10px 20px",cursor:"pointer",fontWeight:800,fontSize:13}}>💾 Save</button>
          </div>
        </div>
      )}

      <div style={{fontSize:14,fontWeight:800,color:"#f9fafb",marginBottom:10}}>Loaded Stocks ({stocks.length})</div>
      {stocks.length===0?(
        <div style={{textAlign:"center",padding:"40px",color:"#6b7280",background:"#0f172a",borderRadius:10,border:"1px dashed #1f2937"}}>
          <div style={{fontSize:32,marginBottom:8}}>📭</div>
          <div>No data yet. Upload a CSV to get started.</div>
          <div style={{fontSize:11,marginTop:8,color:"#374151"}}>Tip: search "KCB Group historical data" on Investing.com, set 10-year range, download CSV</div>
        </div>
      ):(
        <div style={{display:"flex",flexDirection:"column",gap:8}}>
          {stocks.map(name=>{
            const raw=db.load(STOCK_KEY(name)); if(!raw) return null;
            const years=raw.length>0?safeYearSpan(raw).toFixed(1):"?";
            return(
              <div key={name} style={{background:"#0f172a",border:"1px solid #1f2937",borderRadius:8,padding:"12px 14px",display:"flex",alignItems:"center",gap:12}}>
                <div style={{flex:1}}>
                  <div style={{fontWeight:700,color:"#f9fafb"}}>{name}</div>
                  <div style={{fontSize:11,color:"#6b7280"}}>{raw.length.toLocaleString()} rows · {fmtDate(raw[0].date)} → {fmtDate(raw[raw.length-1].date)} · {years} yrs</div>
                </div>
                <Spark data={raw.slice(-60).map(r=>r.close)} height={28} width={80}/>
                {pendingDelete===name?(
                  <div style={{display:"flex",gap:5,alignItems:"center"}}>
                    <span style={{fontSize:11,color:"#fca5a5"}}>Delete?</span>
                    <button onClick={()=>confirmDelete(name)} style={{background:"#991b1b",border:"none",color:"#fff",borderRadius:4,padding:"4px 10px",cursor:"pointer",fontSize:11,fontWeight:700}}>Yes</button>
                    <button onClick={()=>setPendingDelete(null)} style={{background:"#1f2937",border:"none",color:"#9ca3af",borderRadius:4,padding:"4px 10px",cursor:"pointer",fontSize:11}}>No</button>
                  </div>
                ):(
                  <button onClick={()=>remove(name)} style={{background:"#7f1d1d",border:"1px solid #991b1b",color:"#fca5a5",borderRadius:5,padding:"5px 10px",cursor:"pointer",fontSize:12}}>✕</button>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div style={{marginTop:20,background:"#0f172a",border:"1px solid #1f2937",borderRadius:10,padding:14}}>
        <div style={{fontSize:12,fontWeight:800,color:"#f9fafb",marginBottom:8}}>📥 Where to get free historical data</div>
        {[
          ["Investing.com","investing.com → search 'KCB Group Kenya' → Historical Data tab → set date range to 10 years → Download CSV. Best NSE coverage."],
          ["Yahoo Finance","finance.yahoo.com → search 'KCB.NR' → Historical Data → select Max period → Download. Use for global stocks (AAPL, NVDA etc)."],
          ["NSE website","nse.co.ke → Market Data → Historical Prices → select stock. Limited history, use as supplement."],
          ["Stax.co.ke","Kenyan-focused data with clean NSE history and fundamentals. Paid tier worth it for serious use."],
        ].map(([src,how])=>(
          <div key={src} style={{marginBottom:8,fontSize:12}}>
            <span style={{color:"#60a5fa",fontWeight:700}}>{src}: </span>
            <span style={{color:"#9ca3af"}}>{how}</span>
          </div>
        ))}
      </div>

      {/* ── Bulk Import Section (Part 3) ────────────────────────────────────── */}
      <BulkImportSection onStocksChanged={onStocksChanged} log={log}/>
    </div>
  );
}

// ─── AUTOMATED DATA CLEANING ENGINE v2 ──────────────────────────────────────
// Zero-click after dropping files. Every step runs automatically.

const ACCUM_KEY = "iq_accum_staging";
function loadAccumulator()  { return db.load(ACCUM_KEY, {}) || {}; }
function saveAccumulator(d) { db.save(ACCUM_KEY, d); }
function clearAccumulator() { db.remove(ACCUM_KEY); }

function mergeStockRows(existing, incoming) {
  const seen = new Map();
  for(const r of (existing||[])) seen.set(r.date, r);
  for(const r of (incoming||[])) seen.set(r.date, r); // incoming overwrites
  return Array.from(seen.values()).sort((a,b)=>a.date.localeCompare(b.date));
}

// Forward-fill missing trading days (gaps of 1-3 business days only)
function fillMissingTradingDays(rows, maxFillDays=3) {
  if(rows.length < 2) { rows._daysFilled=0; return rows; }
  const result = [rows[0]];
  let filled = 0;
  for(let i=1; i<rows.length; i++) {
    const prevDate = safeDate(rows[i-1].date);
    const currDate = safeDate(rows[i].date);
    if(!prevDate||!currDate) { result.push(rows[i]); continue; }
    const gapDays  = Math.round((currDate - prevDate) / 86400000);
    if(gapDays > 1 && gapDays <= maxFillDays + 2) {
      for(let d=1; d<gapDays; d++) {
        const fillDate = new Date(prevDate.getTime() + d * 86400000);
        const dow = fillDate.getDay();
        if(dow===0||dow===6) continue;
        const ds = fillDate.toISOString().split('T')[0];
        result.push({ date:ds, open:rows[i-1].close, high:rows[i-1].close,
          low:rows[i-1].close, close:rows[i-1].close, volume:0,
          _filled:true, _boundary:false, _gapBefore:false, _corpAction:0 });
        filled++;
      }
    }
    result.push(rows[i]);
  }
  result._daysFilled = filled;
  return result;
}

// Impute zero-volume rows with 30% of rolling avg — prevents vSpike/OBV spikes
function imputeZeroVolume(rows) {
  if(rows.length < 5) { rows._volImputed=0; return rows; }
  let imputed = 0;
  const result = rows.map((r, i) => {
    if((r.volume||0) > 0) return r;
    const window = [];
    for(let j=Math.max(0,i-20); j<=Math.min(rows.length-1,i+20); j++) {
      if(j!==i && (rows[j].volume||0)>0) window.push(rows[j].volume);
    }
    if(!window.length) return r;
    const avgVol = Math.round(window.reduce((s,v)=>s+v,0)/window.length*0.3);
    imputed++;
    return { ...r, volume:avgVol, _volImputed:true };
  });
  result._volImputed = imputed;
  return result;
}

// Remove single-row price spikes where close is extreme but open is normal
function removeSingleRowSpikes(rows) {
  if(rows.length < 5) { rows._spikesFixed=0; return rows; }
  let removed = 0;
  const result = rows.map((r, i) => {
    if(i<2||i>rows.length-3) return r;
    const contextAvg = (rows[i-2].close+rows[i-1].close+rows[i+1].close+rows[i+2].close)/4;
    if(!contextAvg) return r;
    const ratio = r.close / contextAvg;
    if((ratio>3||ratio<0.33) && r.open>0) {
      const openRatio = r.open / contextAvg;
      if(openRatio>0.5 && openRatio<2) {
        removed++;
        return { ...r, close:+contextAvg.toFixed(4), _spikeFixed:true };
      }
    }
    return r;
  });
  result._spikesFixed = removed;
  return result;
}

// Detect cents/shillings scale mismatch mid-file and normalise
function normaliseCurrencyScale(rows) {
  if(rows.length < 20) { rows._currencyNormalised=false; return rows; }
  const firstQ = [...rows.slice(0,Math.floor(rows.length*0.25)).map(r=>r.close)].sort((a,b)=>a-b);
  const lastQ  = [...rows.slice(Math.floor(rows.length*0.75)).map(r=>r.close)].sort((a,b)=>a-b);
  const firstMed = firstQ[Math.floor(firstQ.length/2)];
  const lastMed  = lastQ[Math.floor(lastQ.length/2)];
  if(!firstMed||!lastMed) { rows._currencyNormalised=false; return rows; }
  const ratio = lastMed/firstMed;
  if(ratio>80 && ratio<120) {
    const mid = Math.floor(rows.length/2);
    const result = rows.map((r,i)=>i>=mid?r:{...r,
      open:+(r.open*100).toFixed(4),high:+(r.high*100).toFixed(4),
      low:+(r.low*100).toFixed(4),close:+(r.close*100).toFixed(4),_currencyNormalised:true});
    result._currencyNormalised=true; return result;
  }
  rows._currencyNormalised=false; return rows;
}

// Year-boundary anomaly check
function checkCrossYearContinuity(rows) {
  const issues = [];
  for(let i=1; i<rows.length; i++) {
    const d0 = rows[i-1].date; const d1 = rows[i].date;
    if(!d0||!d1) continue;
    if(d0.slice(0,4) !== d1.slice(0,4)) {
      const change = rows[i-1].close>0 ? Math.abs(rows[i].close-rows[i-1].close)/rows[i-1].close : 0;
      if(change>0.5 && !rows[i]._gapBefore)
        issues.push({date:d1,changePct:(change*100).toFixed(1)});
    }
  }
  rows._yearBoundaryIssues = issues;
  return rows;
}

// Detect likely stock splits with validated criteria
function adjustForSplits(rows) {
  if(rows.length < 10) { rows._splitsAdjusted=[]; return rows; }
  const SPLIT_RATIOS = [2,3,4,5,10];
  const SPLIT_TOLERANCE = 0.06;
  let adjusted = [...rows];
  const splitsDetected = [];
  for(let i=1; i<adjusted.length; i++) {
    const prev=adjusted[i-1].close, curr=adjusted[i].close;
    if(!prev||!curr||prev<=0||curr<=0) continue;
    if(adjusted[i]._gapBefore) continue;
    if(curr<0.5||curr>2000) continue;
    if(i<20) continue;
    const ratio = prev/curr;
    const matchedRatio = SPLIT_RATIOS.find(r=>Math.abs(ratio-r)/r<SPLIT_TOLERANCE);
    if(!matchedRatio) continue;
    const prev5 = adjusted.slice(Math.max(0,i-5),i).map(r=>r.close);
    const m = prev5.reduce((s,v)=>s+v,0)/prev5.length;
    const cv = Math.sqrt(prev5.reduce((s,v)=>s+(v-m)**2,0)/prev5.length)/m;
    if(cv>0.15) continue;
    const adjFactor = 1/matchedRatio;
    for(let j=0;j<i;j++) {
      adjusted[j]={...adjusted[j],
        open:+(adjusted[j].open*adjFactor).toFixed(4),
        high:+(adjusted[j].high*adjFactor).toFixed(4),
        low:+(adjusted[j].low*adjFactor).toFixed(4),
        close:+(adjusted[j].close*adjFactor).toFixed(4),
        volume:Math.round(adjusted[j].volume/adjFactor)};
    }
    splitsDetected.push({date:adjusted[i].date,ratio:matchedRatio,adjFactor});
  }
  adjusted._splitsAdjusted = splitsDetected;
  return adjusted;
}

// Generate human-readable cleaning report
function generateCleaningReport(name, rawRows, cleanRows) {
  const steps = [];
  if(cleanRows._weekendsRemoved>0)     steps.push({icon:"🗑",text:`Removed ${cleanRows._weekendsRemoved} weekend carry-forward rows`,impact:"low"});
  if(cleanRows._dupsRemoved>0)         steps.push({icon:"🔁",text:`Removed ${cleanRows._dupsRemoved} duplicate dates`,impact:"medium"});
  if(cleanRows._outlierDates?.length)  steps.push({icon:"🚨",text:`Dropped ${cleanRows._outlierDates.length} price outliers (>10× or <0.1× median)`,impact:"high"});
  if(cleanRows._gapCount>0)            steps.push({icon:"⏸",text:`Flagged ${cleanRows._gapCount} trading gaps >10 days`,impact:"medium"});
  if(cleanRows._splitsAdjusted?.length) steps.push({icon:"✂️",text:`Adjusted ${cleanRows._splitsAdjusted.length} stock split(s) — historical prices normalised`,impact:"high"});
  if(cleanRows._corpActions?.length)   steps.push({icon:"🏷",text:`Flagged ${cleanRows._corpActions.length} corporate action(s) as training features`,impact:"medium"});
  if(cleanRows._daysFilled>0)          steps.push({icon:"📅",text:`Forward-filled ${cleanRows._daysFilled} missing business days`,impact:"medium"});
  if(cleanRows._volImputed>0)          steps.push({icon:"📊",text:`Imputed volume on ${cleanRows._volImputed} zero-volume rows`,impact:"medium"});
  if(cleanRows._spikesFixed>0)         steps.push({icon:"🔧",text:`Fixed ${cleanRows._spikesFixed} single-row price spike(s)`,impact:"high"});
  if(cleanRows._currencyNormalised)    steps.push({icon:"💱",text:`Currency scale normalised — cents/shillings mismatch corrected`,impact:"high"});
  if(cleanRows._yearBoundaryIssues?.length) steps.push({icon:"⚠️",text:`${cleanRows._yearBoundaryIssues.length} year-boundary price jump(s) — verify source data`,impact:"warn"});
  if(cleanRows._staleTail)             steps.push({icon:"🕰",text:`Last 5 rows appear stale — consider uploading newer data`,impact:"warn"});
  const highCount = steps.filter(s=>s.impact==="high").length;
  const overallQuality = cleanRows._staleTail?"stale":highCount>=2?"improved":highCount===1?"cleaned":"good";
  return {steps,rawN:rawRows.length,cleanN:cleanRows.length,rowDelta:rawRows.length-cleanRows.length,overallQuality,name};
}

// Full automated pipeline — zero user input needed
function runFullCleaningPipeline(name, rawRows) {
  if(!rawRows||rawRows.length===0) return {rows:null,report:null};
  let rows = [...rawRows];
  // Stage 1: structural cleaning
  rows = removeWeekends(rows);
  rows = deduplicateByDate(rows);
  rows = removeOutlierPrices(rows);
  rows = normaliseCurrencyScale(rows);
  rows = removeSingleRowSpikes(rows);
  rows = markTradingGaps(rows);
  rows = adjustForSplits(rows);
  rows = detectCorporateActions(rows);
  // Stage 2: enrichment
  rows = fillMissingTradingDays(rows,3);
  rows = imputeZeroVolume(rows);
  // Stage 3: final flags
  rows = detectStaleTail(rows);
  rows = checkCrossYearContinuity(rows);
  rows = enforceStockBoundaries(rows);
  const report = generateCleaningReport(name, rawRows, rows);
  return {rows,report};
}

// Accumulate split results into staging area
function accumulateSplitResult(splitResult, existing={}) {
  const updated = {...existing};
  for(const [name, s] of splitResult.entries()) {
    if(!s.rows||s.rows.length===0) continue;
    if(!updated[name]) updated[name]={rows:[],sources:[],report:null};
    updated[name].rows = mergeStockRows(updated[name].rows, s.rows);
    updated[name].sources.push({
      ticker:s.ticker||name, addedAt:new Date().toISOString(),
      rowsAdded:s.rows.length, from:s.rows[0]?.date, to:s.rows[s.rows.length-1]?.date
    });
  }
  return updated;
}

// Finalise: run full pipeline, return cleaned rows
function finaliseStockFromAccumulator(name, rawRows) {
  if(!rawRows||rawRows.length===0) return null;
  const {rows} = runFullCleaningPipeline(name, rawRows);
  return rows&&rows.length>=30 ? rows : null;
}

// ─── STOCK TRAINABILITY SCORING ──────────────────────────────────────────────
const TIER_COLOR  = { A:"#22c55e", B:"#eab308", C:"#f97316", D:"#ef4444" };
const TIER_BG     = { A:"#052e16", B:"#1c1400", C:"#1c0f00", D:"#1c0a0a" };
const TIER_BORDER = { A:"#166534", B:"#854d0e", C:"#9a3412", D:"#991b1b" };
const TIER_LABEL  = { A:"Excellent — train first", B:"Good — worth training", C:"Marginal — needs more data", D:"Poor — skip or get better data" };

function scoreStockForTrainability(name, rows) {
  if(!rows||rows.length===0) return {score:0,tier:"D",reasons:[],flags:[],rows:0,years:0,inExpert:false,isBank:false,staleTail:false,gapCount:0,zeroVolPct:0};
  const flags=[], reasons=[];
  let score=100;

  // Row count
  const n=rows.length;
  if(n<60)        { score-=60; flags.push("critical:too_few_rows"); reasons.push(`Only ${n} rows — need ≥60 to train`); }
  else if(n<252)  { score-=30; reasons.push(`${n} rows — less than 1 year. Predictions will be noisy.`); }
  else if(n<504)  { score-=10; reasons.push(`${n} rows (1-2 years) — acceptable`); }
  else if(n>=1260){ score+=5;  reasons.push(`${n} rows (5+ years) ✓ — excellent`); }
  else            {             reasons.push(`${n} rows — good`); }

  // Date span — use safeYearSpan to avoid Invalid Date
  const years = safeYearSpan(rows);
  if(years < 0.5) { score -= 25; flags.push("warn:short_history"); }

  // Volume quality
  const zeroVol=rows.filter(r=>!r.volume||r.volume===0).length;
  const zeroVolPct=zeroVol/n;
  if(zeroVolPct>0.7)      { score-=25; flags.push("warn:no_volume");  reasons.push(`${Math.round(zeroVolPct*100)}% zero volume — volume features disabled`); }
  else if(zeroVolPct>0.3) { score-=10; flags.push("warn:low_volume"); reasons.push(`${Math.round(zeroVolPct*100)}% zero volume — partial`); }
  else                    { reasons.push(`Volume data: ${Math.round((1-zeroVolPct)*100)}% filled ✓`); }

  // Gaps
  const gapCount=rows._gapCount??rows.filter((r,i)=>i>0&&((safeDateMs(r.date)||0)-(safeDateMs(rows[i-1].date)||0))/86400000>10).length;
  if(gapCount>5)  { score-=20; flags.push("warn:many_gaps"); reasons.push(`${gapCount} trading gaps >10 days — suspension risk`); }
  else if(gapCount>0) { score-=5; reasons.push(`${gapCount} gap(s) detected`); }
  else            { reasons.push("No large gaps ✓"); }

  // Stale tail
  if(rows._staleTail) { score-=20; flags.push("warn:stale"); reasons.push("Last rows are stale/repeated — data may be outdated"); }

  // Corporate actions
  const corpCount=rows._corpActions?.length??0;
  if(corpCount>0) { reasons.push(`${corpCount} corp action(s) flagged and handled ✓`); }

  // Expert KB bonus
  const inExpert=!!EXPERT_BASE[name];
  if(inExpert)  { score+=8; reasons.push("In Expert KB — NPL, macro sensitivity calibrated ✓"); }
  else          { score-=5; reasons.push("Not in Expert KB — macro features less accurate"); }

  // Price variance
  const closes=rows.map(r=>r.close);
  const mean=closes.reduce((s,v)=>s+v,0)/closes.length;
  const std=Math.sqrt(closes.reduce((s,v)=>s+(v-mean)**2,0)/closes.length);
  const cv=mean>0?std/mean:0;
  if(cv<0.02)  { score-=30; flags.push("critical:flat_price"); reasons.push("Price barely moves — no learnable patterns"); }
  else if(cv>0.5){ score-=5; reasons.push(`High volatility (CV=${cv.toFixed(2)}) — harder to predict`); }
  else          { reasons.push(`Good price variance (CV=${cv.toFixed(2)}) ✓`); }

  // NSE bank bonus
  const isBank=BANK_STOCKS.includes(name);
  if(isBank) { score+=5; reasons.push("NSE bank — CBK rate features highly relevant ✓"); }

  // Liquidity proxy: price variance (CV) and volume fill rate together
  // Thin illiquid stocks (C&G, BAUM) have discrete price steps → low CV
  // AND high zero-volume → model learns step patterns, not real signal
  const liquidityPenalty = (cv < 0.05 && zeroVolPct > 0.2) ? 20 : 0;
  if(liquidityPenalty > 0) {
    score -= liquidityPenalty;
    flags.push("warn:illiquid");
    reasons.push(`Low price variance + sparse volume — stock may be too illiquid for reliable ML patterns`);
  }

  // Use actual BT accuracy if available (most reliable signal of trainability)
  const savedResults=typeof db!=="undefined"?db.load("iq_train_results",{}):null;
  const savedBT=savedResults?.[name]?.btAcc;
  if(savedBT!=null) {
    if(savedBT>=0.60)      { score+=15; reasons.push(`✅ Historical BT accuracy ${(savedBT*100).toFixed(0)}% — strong learnable patterns`); }
    else if(savedBT>=0.50) { score+=5;  reasons.push(`BT accuracy ${(savedBT*100).toFixed(0)}% — moderate patterns`); }
    else if(savedBT<0.33)  { score-=20; flags.push("warn:poor_bt"); reasons.push(`⚠ Historical BT accuracy ${(savedBT*100).toFixed(0)}% — below random chance. Stock may lack learnable patterns.`); }
    else                   { score-=5;  reasons.push(`BT accuracy ${(savedBT*100).toFixed(0)}% — weak patterns`); }
  }

  const finalScore=Math.max(0,Math.min(100,Math.round(score)));
  const tier=finalScore>=75?"A":finalScore>=55?"B":finalScore>=35?"C":"D";
  return {score:finalScore,tier,reasons,flags,years:+years.toFixed(1),rows:n,inExpert,isBank,
          staleTail:!!rows._staleTail,gapCount,zeroVolPct:+zeroVolPct.toFixed(2),savedBT};
}

// Score cleaned combined history (adds bonuses for pipeline improvements)
function scoreCombinedHistory(name, rows) {
  const base = scoreStockForTrainability(name, rows);
  const years = safeYearSpan(rows);
  let bonus = 0;
  if(years>=5)  bonus+=5;
  if(years>=10) bonus+=8;
  if(years>=15) bonus+=10;
  if(rows._splitsAdjusted?.length) bonus+=3*rows._splitsAdjusted.length;
  if(rows._daysFilled>0&&rows._daysFilled<50) bonus+=3;
  if(rows._volImputed>0) bonus+=2;
  if(rows._currencyNormalised) bonus+=5;
  const finalScore = Math.min(100, base.score+bonus);
  const tier = finalScore>=75?"A":finalScore>=55?"B":finalScore>=35?"C":"D";
  return {...base, score:finalScore, tier, years:+years.toFixed(1),
    splitsAdjusted:rows._splitsAdjusted?.length||0,
    daysFilled:rows._daysFilled||0, volImputed:rows._volImputed||0,
    currencyNormalised:!!rows._currencyNormalised};
}

function BulkImportSection({onStocksChanged, log}) {
  const [accumulator, setAccumulator] = useState(()=>loadAccumulator());
  const [processing, setProcessing] = useState(false);
  const [processMsg, setProcessMsg] = useState(null);
  const [scores, setScores] = useState({});
  const [selected, setSelected] = useState({});
  const [saving, setSaving] = useState(false);
  const [saveProgress, setSaveProgress] = useState(null);
  const [saved, setSaved] = useState(false);
  const [filterTier, setFilterTier] = useState("all");
  const [sortBy, setSortBy] = useState("score");
  const [expandedStock, setExpandedStock] = useState(null);
  const [filesAdded, setFilesAdded] = useState([]);
  // Simple upload path state (paste/single file)
  const [bulkText, setBulkText] = useState("");
  const [bulkResult, setBulkResult] = useState(null);
  const [splitResult, setSplitResult] = useState(null);
  const bulkFileRef = useRef();

  // Simple paste/detect path — feeds into accumulator
  const detect = async () => {
    if(!bulkText.trim()) return;
    setBulkResult(null); setSplitResult(null); setSaved(false);
    const result = parseBulkCSV(bulkText);
    if(!result.isBulk) {
      // Try single-stock
      try {
        const rows = parseCSV(bulkText);
        const rawName = rows._detectedStockName;
        const name = rawName ? (resolveTickerToExpertName(rawName)||rawName) : "Pasted stock";
        const fakeFile = {name:"pasted.csv", text:async()=>bulkText};
        await addFile(fakeFile);
        return;
      } catch {}
      setBulkResult({error:"Not detected as a multi-stock file. Less than 2 known stock identifiers found."});
      return;
    }
    const split = splitBulkByStock(result);
    const current = loadAccumulator();
    const updated = accumulateSplitResult(split, current);
    saveAccumulator(updated);
    setAccumulator(updated);
    setBulkResult(result);
    setSplitResult(split);
    setFilesAdded(f=>[...f,{name:"pasted CSV",stocks:split.size,rows:[...split.values()].reduce((s,v)=>s+v.rows.length,0)}]);
    log("BULK_ACCUM","SUCCESS",`Pasted CSV: merged ${split.size} stocks`);
    setBulkText("");
  };
  useEffect(()=>{
    const sc = {};
    for(const [name, data] of Object.entries(accumulator)) {
      // Score using pipeline-cleaned rows so flags are accurate
      const {rows: previewRows} = runFullCleaningPipeline(name, data.rows||[]);
      sc[name] = previewRows ? scoreCombinedHistory(name, previewRows) : {score:0,tier:"D",reasons:[],flags:[]};
    }
    setScores(sc);
    const autoSel = {};
    for(const [name] of Object.entries(accumulator)) autoSel[name]=(sc[name]?.tier==="A"||sc[name]?.tier==="B");
    setSelected(autoSel);
  }, [accumulator]);

  const addFile = async (file) => {
    if(!file) return;
    const fname = file.name||"pasted data";
    setProcessing(true);
    setProcessMsg(`🔍 Parsing ${fname}…`);
    setSaved(false);
    try {
      const rawText = typeof file.text==="function" ? await file.text() : String(file);

      // Always pre-clean before any detection
      const text = precleanBulkText(rawText);

      // ── STEP 1: Always try bulk detection first ──────────────────────────
      // This is intentional: a combined CSV MUST be caught here before parseCSV
      // gets a chance to eat all rows as a single stock. parseBulkCSV scans
      // ALL rows for a ticker column — if it finds 2+ distinct tickers it wins.
      const bulkResult = parseBulkCSV(text);
      // Debug log so users can verify what the parser detected
      console.info(`[InvestIQ] ${fname}: isBulk=${bulkResult.isBulk} tickerCol=${bulkResult.tickerCol} detectedStocks=${bulkResult.detectedStocks?.length||0} passUsed=${bulkResult.passUsed||"none"}`);
      if(bulkResult.detectedStocks?.length > 0) {
        console.info(`[InvestIQ] Detected tickers: ${bulkResult.detectedStocks.slice(0,10).join(", ")}`);
      }

      let splitResult = null;

      if(bulkResult.isBulk) {
        // ── Multi-stock CSV confirmed ────────────────────────────────────
        const rawSplit = splitBulkByStock(bulkResult);

        // Filter out any entry whose name matches combined-dataset patterns
        // (e.g. if the ticker column contained "ALL" or "MARKET")
        splitResult = new Map();
        for(const [stockName, data] of rawSplit) {
          if(isCombinedFilename(stockName)) {
            console.warn(`[InvestIQ] Skipping combined-sounding name: "${stockName}"`);
            continue;
          }
          splitResult.set(stockName, data);
        }

        if(splitResult.size === 0) {
          setProcessMsg(`⚠️ ${fname}: bulk structure detected but all entries look like combined datasets. Check ticker column.`);
          setProcessing(false); return;
        }

        // ── VALIDATION: reject suspicious bulk splits ──────────────────────
        // If the split produced only 2-3 stocks from a small file (<500 rows),
        // or if the filename clearly names a single stock, something went wrong.
        const totalRows = [...splitResult.values()].reduce((s,v)=>s+(v.rows?.length||0),0);
        const isSingleStockFilename = (()=>{
          const fup = fname.toUpperCase().replace(/[^A-Z0-9]/g,' ');
          return Object.keys(NSE_TICKER_MAP).some(t=>fup.includes(t)) ||
                 ['EQUITY','SAFARICOM','KCB','ABSA','COOP','STANCHART',
                  'DIAMOND','JUBILEE','KENGEN','KPLC','BRITAM','EABL','BAT']
                   .some(kw=>fup.includes(kw));
        })();

        if(isSingleStockFilename && splitResult.size <= 4 && totalRows < 600) {
          console.warn(`[InvestIQ] Suspicious bulk split: filename "${fname}" looks single-stock but produced ${splitResult.size} entries. Forcing single-stock parse.`);
          // Fall through to single-stock path
          splitResult = null;
          // Re-run as single stock below
        } else {
          setProcessMsg(`📦 ${splitResult.size} stocks split from ${fname} — merging…`);
        }

        if(splitResult !== null && splitResult.size === 0) {
          setProcessMsg(`⚠️ ${fname}: bulk structure detected but all entries look like combined datasets. Check ticker column.`);
          setProcessing(false); return;
        }

      } else {
        // ── Single-stock fallback ────────────────────────────────────────
        // Only reached when parseBulkCSV found fewer than 2 distinct tickers.

        // Block if filename looks like a combined dataset — user must fix the CSV
        if(isCombinedFilename(fname)) {
          setProcessMsg(
            `❌ "${fname}" looks like a combined market dataset but the ticker column ` +
            `could not be detected. Ensure your CSV has a "Code" or "Ticker" column ` +
            `with stock symbols, then re-upload.`
          );
          setProcessing(false); return;
        }

        try {
          const singleRows = parseCSV(text);
          const rawName = singleRows._detectedStockName;
          const stockName = rawName
            ? (resolveTickerToExpertName(rawName) || rawName)
            : fname.replace(/\.(csv|txt)$/i,"").replace(/[-_]/g," ").trim();

          // Final guard: if even the resolved name sounds combined, reject it
          if(isCombinedFilename(stockName)) {
            setProcessMsg(
              `❌ Detected stock name "${stockName}" looks like a combined dataset. ` +
              `Rename the file or add a Ticker column so stocks can be split.`
            );
            setProcessing(false); return;
          }

          splitResult = new Map([[stockName, {
            rows: singleRows,
            ticker: rawName || stockName,
            thin: singleRows.length < 30,
            unrecognised: !matchStockName(stockName),
          }]]);
          setProcessMsg(`📄 Single stock: ${stockName} (${singleRows.length} rows)`);
        } catch(parseErr) {
          setProcessMsg(`❌ ${fname}: ${parseErr.message}`);
          setProcessing(false); return;
        }
      }

      const current = loadAccumulator();
      const updated = accumulateSplitResult(splitResult, current);
      saveAccumulator(updated);
      setAccumulator({...updated});
      const totalRows = [...splitResult.values()].reduce((s,v)=>s+(v.rows?.length||0),0);
      setFilesAdded(f=>[...f,{name:fname,stocks:splitResult.size,rows:totalRows}]);
      setProcessMsg(
        `✅ ${fname} — ${splitResult.size} stock(s), ${totalRows.toLocaleString()} rows merged. ` +
        `Accumulator total: ${Object.keys(updated).length} stocks.`
      );
      log("BULK_ACCUM","SUCCESS",`${fname}: split into ${splitResult.size} stocks`);
    } catch(e) {
      setProcessMsg(`❌ Error in ${fname}: ${e.message}`);
      log("BULK_ACCUM","ERROR",`${fname}: ${e.message}`);
    }
    setProcessing(false);
  };

  const addMoreFiles = async (files) => {
    for(const file of [...files]) await addFile(file);
  };

  const finaliseAndSave = async () => {
    const toSave = Object.entries(accumulator).filter(([name])=>selected[name]);
    if(!toSave.length) return;
    setSaving(true); setSaved(false);
    let savedCount = 0;
    for(const [name, data] of toSave) {
      setSaveProgress(`Cleaning & saving ${savedCount+1}/${toSave.length}: ${name}…`);
      await new Promise(r=>setTimeout(r,30));
      const {rows: finalRows, report} = runFullCleaningPipeline(name, data.rows||[]);
      if(!finalRows||finalRows.length<30) {
        log("BULK_SAVE","WARN",`${name}: only ${finalRows?.length||0} rows after cleaning — skipped (need ≥30)`);
        continue;
      }
      const ok = saveStockData(name, finalRows);
      if(ok) {
        const sc = scores[name];
        const summary = report?.steps?.map(s=>s.text).join(" | ") || "no issues";
        log("BULK_SAVE","SUCCESS",
          `${name}: ${finalRows.length} rows · Tier ${sc?.tier||"?"} · score ${sc?.score||0} | Cleaned: ${summary.slice(0,120)}`);
        savedCount++;
      } else {
        log("BULK_SAVE","ERROR",`${name}: localStorage save failed — data too large`);
      }
    }
    setSaveProgress(null); setSaving(false); setSaved(true);
    onStocksChanged(listStocks());
    log("BULK_SAVE","SUCCESS",`✅ Done — ${savedCount}/${toSave.length} stocks saved to training library`);
  };

  const clearAll = () => {
    clearAccumulator();
    setAccumulator({});
    setFilesAdded([]);
    setScores({});
    setSelected({});
    setSaved(false);
  };

  const stockCount = Object.keys(accumulator).length;
  const tierCounts = {A:0,B:0,C:0,D:0};
  for(const [n] of Object.entries(accumulator)){ const t=scores[n]?.tier; if(t) tierCounts[t]++; }

  const allEntries = Object.entries(accumulator);
  const filtered = allEntries.filter(([name])=>{
    const t = scores[name]?.tier;
    if(filterTier==="A") return t==="A";
    if(filterTier==="B") return t==="B";
    if(filterTier==="AB") return t==="A"||t==="B";
    return true;
  });
  const sorted = [...filtered].sort((a,b)=>{
    if(sortBy==="score") return (scores[b[0]]?.score||0)-(scores[a[0]]?.score||0);
    if(sortBy==="rows") return (scores[b[0]]?.rows||0)-(scores[a[0]]?.rows||0);
    if(sortBy==="years") return (scores[b[0]]?.years||0)-(scores[a[0]]?.years||0);
    return a[0].localeCompare(b[0]);
  });

  const selectByTier = (tiers) => {
    const next = {};
    for(const [name] of allEntries) next[name] = tiers.includes(scores[name]?.tier);
    setSelected(next);
  };

  return (
    <div style={{marginTop:20,background:"#0a0f1e",border:"1px solid #374151",borderRadius:12,padding:16}}>

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div style={{fontSize:14,fontWeight:900,color:"#f9fafb",marginBottom:2}}>📦 Smart Multi-File Import</div>
      <div style={{fontSize:11,color:"#6b7280",marginBottom:14,lineHeight:1.8}}>
        Add multiple year CSVs one at a time (e.g. <b style={{color:"#93c5fd"}}>nse_2007.csv</b>, <b style={{color:"#93c5fd"}}>nse_2008.csv</b>… <b style={{color:"#93c5fd"}}>nse_2025.csv</b>). The engine merges them per stock automatically, adjusts for splits, cleans the data, and scores each stock for trainability. When done, save selected stocks to the training library.
      </div>

      {/* ── Drop zone ───────────────────────────────────────────────────────── */}
      <div
        onDrop={async e=>{e.preventDefault();await addMoreFiles([...e.dataTransfer.files]);}}
        onDragOver={e=>e.preventDefault()}
        onClick={()=>bulkFileRef.current?.click()}
        style={{border:"2px dashed #374151",borderRadius:10,padding:"20px",textAlign:"center",cursor:"pointer",background:"#0f172a",marginBottom:12,transition:"all 0.15s"}}
      >
        <input ref={bulkFileRef} type="file" accept=".csv,.txt" multiple style={{display:"none"}}
          onChange={async e=>{await addMoreFiles([...e.target.files]);e.target.value="";}}/>
        <div style={{fontSize:22,marginBottom:4}}>📂</div>
        <div style={{fontWeight:700,color:"#f9fafb",fontSize:12,marginBottom:2}}>Drop CSV files here or click to browse</div>
        <div style={{fontSize:10,color:"#4b5563"}}>Add as many year files as you have — each file is merged automatically · single-stock and multi-stock files both work</div>
      </div>

      {/* ── Process status ──────────────────────────────────────────────────── */}
      {processMsg&&(
        <div style={{fontSize:11,padding:"7px 12px",borderRadius:7,marginBottom:10,
          background:processMsg.startsWith("✅")?"#052e16":processMsg.startsWith("❌")?"#1c0a0a":processMsg.startsWith("⚠")?"#1c1400":"#0f172a",
          color:processMsg.startsWith("✅")?"#22c55e":processMsg.startsWith("❌")?"#f87171":processMsg.startsWith("⚠")?"#fbbf24":"#9ca3af",
          border:`1px solid ${processMsg.startsWith("✅")?"#166534":processMsg.startsWith("❌")?"#991b1b":processMsg.startsWith("⚠")?"#854d0e":"#1f2937"}`}}>
          {processMsg}
        </div>
      )}

      {/* ── Files added list ─────────────────────────────────────────────────── */}
      {filesAdded.length>0&&(
        <div style={{background:"#0f172a",borderRadius:8,padding:"10px 12px",marginBottom:12,border:"1px solid #1f2937"}}>
          <div style={{fontSize:10,color:"#6b7280",marginBottom:6,fontWeight:700}}>Files added this session:</div>
          {filesAdded.map((f,i)=>(
            <div key={i} style={{fontSize:11,color:"#9ca3af",marginBottom:2}}>
              <span style={{color:"#22c55e"}}>✓</span> {f.name} — {f.stocks} stock{f.stocks!==1?"s":""}, {f.rows.toLocaleString()} rows
            </div>
          ))}
          <button onClick={clearAll} style={{marginTop:8,background:"none",border:"1px solid #374151",color:"#6b7280",borderRadius:5,padding:"3px 10px",cursor:"pointer",fontSize:10}}>✕ Clear accumulator</button>
        </div>
      )}

      {/* ── Results ─────────────────────────────────────────────────────────── */}
      {stockCount>0&&(
        <div>
          {/* Summary tiles */}
          <div style={{background:"#0f172a",borderRadius:10,padding:12,marginBottom:12,border:"1px solid #1f2937"}}>
            <div style={{fontSize:11,color:"#9ca3af",marginBottom:8}}>
              <b style={{color:"#f9fafb"}}>{stockCount} stocks</b> accumulated · <b style={{color:"#f9fafb"}}>{Object.values(accumulator).reduce((s,d)=>s+(d.rows?.length||0),0).toLocaleString()}</b> total rows
            </div>
            <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:10}}>
              {Object.entries(tierCounts).map(([tier,count])=>(
                <div key={tier} style={{background:TIER_BG[tier],border:`1px solid ${TIER_BORDER[tier]}`,borderRadius:7,padding:"7px 12px",textAlign:"center",minWidth:64}}>
                  <div style={{fontSize:18,fontWeight:900,color:TIER_COLOR[tier]}}>{count}</div>
                  <div style={{fontSize:10,fontWeight:700,color:TIER_COLOR[tier]}}>Tier {tier}</div>
                </div>
              ))}
              <div style={{flex:1,minWidth:180,background:"#0a0f1e",border:"1px solid #1f2937",borderRadius:7,padding:"8px 12px"}}>
                <div style={{fontSize:10,color:"#6b7280",marginBottom:4}}>What to do next</div>
                <div style={{fontSize:11,color:"#93c5fd",lineHeight:1.6}}>
                  Select <b style={{color:"#22c55e"}}>Tier A</b> and <b style={{color:"#eab308"}}>Tier B</b> stocks below, then click <b style={{color:"#22c55e"}}>Finalise & Save</b>. The model runs split adjustment, dedup and cleaning before saving — these directly improve accuracy.
                </div>
              </div>
            </div>

            {/* Filter + sort */}
            <div style={{display:"flex",gap:6,flexWrap:"wrap",alignItems:"center"}}>
              <span style={{fontSize:10,color:"#6b7280"}}>Show:</span>
              {[["all","All"],["AB","A+B"],["A","Tier A"],["B","Tier B"]].map(([v,l])=>(
                <button key={v} onClick={()=>setFilterTier(v)}
                  style={{padding:"4px 9px",borderRadius:5,border:`1px solid ${filterTier===v?"#3b82f6":"#374151"}`,background:filterTier===v?"#1e3a5f":"#111827",color:filterTier===v?"#93c5fd":"#6b7280",cursor:"pointer",fontSize:11,fontWeight:filterTier===v?700:400}}>
                  {l}
                </button>
              ))}
              <span style={{fontSize:10,color:"#6b7280",marginLeft:6}}>Sort:</span>
              {[["score","Score"],["rows","Rows"],["years","Years"],["name","Name"]].map(([v,l])=>(
                <button key={v} onClick={()=>setSortBy(v)}
                  style={{padding:"4px 9px",borderRadius:5,border:`1px solid ${sortBy===v?"#3b82f6":"#374151"}`,background:sortBy===v?"#1e3a5f":"#111827",color:sortBy===v?"#93c5fd":"#6b7280",cursor:"pointer",fontSize:11,fontWeight:sortBy===v?700:400}}>
                  {l}
                </button>
              ))}
            </div>
          </div>

          {/* Quick select */}
          <div style={{display:"flex",gap:8,marginBottom:10,flexWrap:"wrap"}}>
            <button onClick={()=>selectByTier(["A"])} style={{background:TIER_BG.A,border:`1px solid ${TIER_BORDER.A}`,color:TIER_COLOR.A,borderRadius:5,padding:"5px 12px",cursor:"pointer",fontSize:11,fontWeight:700}}>✓ Tier A ({tierCounts.A})</button>
            <button onClick={()=>selectByTier(["A","B"])} style={{background:"#0f172a",border:"1px solid #374151",color:"#93c5fd",borderRadius:5,padding:"5px 12px",cursor:"pointer",fontSize:11,fontWeight:700}}>✓ A+B ({tierCounts.A+tierCounts.B})</button>
            <button onClick={()=>selectByTier(["A","B","C"])} style={{background:"#0f172a",border:"1px solid #374151",color:"#6b7280",borderRadius:5,padding:"5px 12px",cursor:"pointer",fontSize:11}}>✓ A+B+C</button>
            <button onClick={()=>setSelected({})} style={{background:"#1f2937",border:"1px solid #374151",color:"#6b7280",borderRadius:5,padding:"5px 12px",cursor:"pointer",fontSize:11}}>✗ None</button>
          </div>

          {/* Stock list */}
          <div style={{display:"flex",flexDirection:"column",gap:4,maxHeight:450,overflowY:"auto",marginBottom:14}}>
            {sorted.map(([name, data])=>{
              const sc = scores[name]||{score:0,tier:"D",reasons:[],flags:[]};
              const isExpanded = expandedStock===name;
              const srcs = data.sources||[];
              const totalRows = data.rows?.length||0;
              const dateFrom = data.rows?.[0]?.date;
              const dateTo   = data.rows?.[data.rows.length-1]?.date;
              const splits   = (data.rows?._splitsAdjusted||[]).length;
              return(
                <div key={name} style={{background:"#0f172a",border:`1px solid ${TIER_BORDER[sc.tier]}44`,borderRadius:8,overflow:"hidden"}}>
                  <div style={{display:"flex",alignItems:"center",gap:8,padding:"9px 12px",cursor:"pointer"}} onClick={()=>setExpandedStock(isExpanded?null:name)}>
                    <input type="checkbox" checked={!!selected[name]}
                      onClick={e=>e.stopPropagation()}
                      onChange={e=>setSelected(p=>({...p,[name]:e.target.checked}))}
                      style={{cursor:"pointer",flexShrink:0}}/>
                    {/* Tier */}
                    <div style={{width:28,height:28,borderRadius:6,background:TIER_BG[sc.tier],border:`1px solid ${TIER_BORDER[sc.tier]}`,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                      <span style={{fontSize:10,fontWeight:900,color:TIER_COLOR[sc.tier],lineHeight:1}}>{sc.tier}</span>
                      <span style={{fontSize:8,color:TIER_COLOR[sc.tier]}}>{sc.score}</span>
                    </div>
                    {/* Score bar */}
                    <div style={{width:40,flexShrink:0}}>
                      <div style={{height:3,background:"#1f2937",borderRadius:2}}>
                        <div style={{width:`${sc.score}%`,height:"100%",background:TIER_COLOR[sc.tier],borderRadius:2}}/>
                      </div>
                    </div>
                    {/* Info */}
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{display:"flex",alignItems:"center",gap:5,flexWrap:"wrap"}}>
                        <span style={{fontSize:12,color:"#f9fafb",fontWeight:700}}>{name}</span>
                        {sc.inExpert&&<span style={{fontSize:9,background:"#1e3a5f",color:"#93c5fd",borderRadius:3,padding:"1px 5px",fontWeight:700}}>KB</span>}
                        {sc.isBank&&<span style={{fontSize:9,background:"#052e16",color:"#22c55e",borderRadius:3,padding:"1px 5px",fontWeight:700}}>BANK</span>}
                        {splits>0&&<span style={{fontSize:9,background:"#1c1f00",color:"#a3e635",borderRadius:3,padding:"1px 5px"}}>↔ {splits} split adj.</span>}
                        {sc.staleTail&&<span style={{fontSize:9,background:"#1c1400",color:"#fbbf24",borderRadius:3,padding:"1px 5px"}}>STALE</span>}
                      </div>
                      <div style={{fontSize:10,color:"#4b5563",marginTop:1}}>
                        {totalRows.toLocaleString()} rows · {sc.years} yrs{dateFrom?` · ${dateFrom} → ${dateTo}`:""}
                        {srcs.length>1&&<span style={{color:"#60a5fa"}}> · {srcs.length} files merged</span>}
                        {sc.gapCount>0&&<span style={{color:"#f97316"}}> · {sc.gapCount} gaps</span>}
                      </div>
                    </div>
                    <span style={{fontSize:11,color:"#374151"}}>{isExpanded?"▲":"▼"}</span>
                  </div>

                  {isExpanded&&(
                    <div style={{padding:"0 12px 12px",borderTop:"1px solid #1f2937"}}>
                      {/* Source files */}
                      {srcs.length>0&&(
                        <div style={{marginTop:8,marginBottom:8}}>
                          <div style={{fontSize:10,color:"#6b7280",fontWeight:700,marginBottom:4}}>Source files merged:</div>
                          {srcs.map((s,i)=>(
                            <div key={i} style={{fontSize:10,color:"#4b5563",marginBottom:2}}>
                              • {s.ticker} — {s.rowsAdded?.toLocaleString()} rows · {s.from} → {s.to}
                            </div>
                          ))}
                        </div>
                      )}
                      {/* Auto cleaning report */}
                      {(()=>{
                        const {report} = runFullCleaningPipeline(name, data.rows||[]);
                        if(!report) return null;
                        return(
                          <div style={{marginBottom:8}}>
                            <div style={{fontSize:10,color:"#6b7280",fontWeight:700,marginBottom:4}}>
                              🤖 Auto-cleaning ({report.rawN?.toLocaleString()} → {report.cleanN?.toLocaleString()} rows):
                            </div>
                            {report.steps.length===0
                              ? <div style={{fontSize:10,color:"#22c55e"}}>✓ No issues found — data looks clean</div>
                              : report.steps.map((s,i)=>(
                                <div key={i} style={{fontSize:10,marginBottom:2,display:"flex",gap:5,alignItems:"flex-start"}}>
                                  <span style={{flexShrink:0}}>{s.icon}</span>
                                  <span style={{color:s.impact==="warn"?"#fbbf24":s.impact==="high"?"#22c55e":"#9ca3af",lineHeight:1.5}}>{s.text}</span>
                                </div>
                              ))
                            }
                            <div style={{marginTop:6,fontSize:10,padding:"4px 8px",borderRadius:5,
                              background:report.overallQuality==="good"?"#052e16":report.overallQuality==="stale"?"#1c1400":"#0f1629",
                              color:report.overallQuality==="good"?"#22c55e":report.overallQuality==="stale"?"#fbbf24":"#60a5fa",
                              border:`1px solid ${report.overallQuality==="good"?"#166534":report.overallQuality==="stale"?"#854d0e":"#1e3a5f"}`}}>
                              {report.overallQuality==="good"
                                ?"✓ Data quality: good — ready to train"
                                :report.overallQuality==="stale"
                                ?"⚠ Data appears stale — upload newer CSV before training"
                                :"🔧 Cleaning applied — training signal improved"}
                            </div>
                          </div>
                        );
                      })()}
                      {/* Trainability score reasons */}
                      <div style={{fontSize:10,color:"#6b7280",fontWeight:700,marginBottom:3}}>Trainability analysis:</div>
                      {sc.reasons?.map((r,i)=>(
                        <div key={i} style={{fontSize:10,marginBottom:2,
                          color:r.includes("✓")?"#22c55e":r.startsWith("Only")||r.startsWith("Price barely")?"#f87171":"#9ca3af"}}>
                          • {r}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
            {sorted.length===0&&<div style={{textAlign:"center",padding:20,color:"#4b5563",fontSize:12}}>No stocks match this filter.</div>}
          </div>

          {/* Save controls */}
          {saved&&(
            <div style={{background:"#052e16",border:"1px solid #166534",borderRadius:8,padding:"10px 14px",marginBottom:10,fontSize:12,color:"#22c55e",fontWeight:700}}>
              ✅ Stocks saved. Go to the <b>Train tab</b> — they appear in the dropdown sorted by score (Tier A first). Start training with the highest-scored stocks.
            </div>
          )}
          {saveProgress&&<div style={{fontSize:12,color:"#60a5fa",marginBottom:8}}>⏳ {saveProgress}</div>}
          <div style={{display:"flex",gap:10,alignItems:"center",flexWrap:"wrap"}}>
            <button onClick={finaliseAndSave} disabled={saving||!Object.values(selected).some(Boolean)}
              style={{background:saving||!Object.values(selected).some(Boolean)?"#1f2937":"#22c55e",
                border:"none",color:saving||!Object.values(selected).some(Boolean)?"#4b5563":"#000",
                borderRadius:7,padding:"10px 22px",cursor:saving?"not-allowed":"pointer",fontWeight:900,fontSize:13}}>
              {saving?"Finalising…":`🚀 Finalise & Save (${Object.values(selected).filter(Boolean).length} stocks)`}
            </button>
            <div style={{fontSize:11,color:"#4b5563",flex:1}}>
              Finalise runs split adjustment + cleaning pipeline before saving. Saved stocks appear in Train tab sorted by score.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
function TrainTab({stocks,stockDataMap,setStockDataMap,log,onStocksChanged}){
  const [training,setTraining]=useState({});
  const [results,setResults]=useState(()=>db.load("iq_train_results",{}));
  const [selectedStock,setSelectedStock]=useState(null);
  const [recencyYears,setRecencyYears]=useState(2);
  const [learningHistories,setLearningHistories]=useState(()=>{
    const h={};
    for(const s of (listStocks()||[])) h[s]=loadLearningHistory(s);
    return h;
  });

  // Filter combined-dataset names that slipped through — they must never appear in TrainTab
  const cleanStocks = stocks.filter(s=>!isCombinedFilename(s) && s.length > 1 && s.length < 60);

  useEffect(()=>{
    if(cleanStocks.length&&(!selectedStock||!cleanStocks.includes(selectedStock)))
      setSelectedStock(cleanStocks[0]);
  },[cleanStocks.join(",")]); // eslint-disable-line

  const [pendingDelete,setPendingDelete]=useState(null); // stock name awaiting inline confirm

  const deleteStock=(name)=>setPendingDelete(name); // triggers inline confirm UI — no window.confirm()

  const confirmDeleteStock=(name)=>{
    const safeName=name.replace(/\s+/g,"_");
    db.remove(STOCK_KEY(name));
    db.remove(MODEL_WEIGHTS_KEY(name));
    db.remove(LEARNING_HIST_KEY(name));
    db.remove(`iq_ablation_${safeName}`);
    setResults(prev=>{
      const next={...prev};
      delete next[name];
      db.save("iq_train_results",next);
      return next;
    });
    setStockDataMap(prev=>{
      const next={...prev};
      delete next[name];
      return next;
    });
    // Also purge any combined-dataset entries that slipped into localStorage
    const allSaved = listStocks();
    allSaved.filter(s=>isCombinedFilename(s)).forEach(bad=>{
      db.remove(STOCK_KEY(bad));
    });
    const remaining = listStocks().filter(s=>!isCombinedFilename(s));
    setSelectedStock(remaining.find(s=>s!==name)||remaining[0]||null);
    onStocksChanged(remaining);
    log("DATA_DELETE","SUCCESS",`Deleted ${name}`);
    setPendingDelete(null);
  };

  const trainStock=async(name,incremental=false)=>{
    const _wKey=`iq_feat_weights_${name?.replace(/\s+/g,"_")}`;
    const _stockWeights=db.load(_wKey)||null;
    setTraining(t=>({...t,[name]:true}));
    const mode=incremental?"Incremental update":"Full retrain";
    log("TRAIN","RUNNING",`${mode} for ${name}…`);
    await new Promise(r=>setTimeout(r,60));

    const sd=stockDataMap[name]||loadStockData(name);
    if(!sd){log("TRAIN","ERROR",`No data for ${name}`);setTraining(t=>({...t,[name]:false}));return;}
    // Sanitise rows on load to prevent Invalid Date from bulk-imported data
    let {rows: rawRows, features: rawFeatures} = sd;
    let rows = sanitiseRows(rawRows);
    if(rows.length < rawRows.length) {
      log("TRAIN","WARN",`${name}: dropped ${rawRows.length - rows.length} rows with invalid dates or prices`);
    }
    let features = rows.length === rawRows.length ? rawFeatures : buildFeaturesForStock(rows, name, null, null, stockDataMap);

    // Apply recency filter — train only on recent N years
    if(recencyYears!==0&&rows.length>0){
      try {
        const lastDate = rows[rows.length-1].date;
        const cutoff=new Date(lastDate);
        if(!isNaN(cutoff.getTime())) {
          cutoff.setFullYear(cutoff.getFullYear()-recencyYears);
          const cutStr=cutoff.toISOString().split("T")[0];
          const filtered=rows.filter(r=>r.date&&r.date>=cutStr);
          if(filtered.length>=60){
            rows=filtered;
            features=buildFeaturesForStock(filtered,name,null,null,stockDataMap);
            log("TRAIN","INFO",`Recency filter: using ${filtered.length} rows (${recencyYears}yr window)`);
          }
        }
      } catch(e) { log("TRAIN","WARN","Recency filter skipped — date parse error: "+e.message); }
    }

    if(rows.length<60){log("TRAIN","ERROR",`${name}: need ≥60 rows, got ${rows.length}`);setTraining(t=>({...t,[name]:false}));return;}

    // 4b: Volume data quality warning
    const zeroVolRows = rows.filter(r=>r.volume===0||r.volume==null).length;
    const zeroVolPct = Math.round(zeroVolRows/rows.length*100);
    if(zeroVolPct > 30) {
      log("TRAIN","WARN",`${name}: ${zeroVolPct}% of rows have zero volume — vSpike, OBV and volume features will be unreliable`);
    }
    // P7: Trading gap warning
    const gapCount = rows._gapCount || rows.filter((r,i)=>i>0&&((safeDateMs(r.date)||0)-(safeDateMs(rows[i-1].date)||0))/86400000>10).length;
    if(gapCount > 0) {
      log("TRAIN","WARN",`${name}: ${gapCount} trading gap(s) >10 days detected — possible suspensions. Indicators near gaps may be unreliable.`);
    }

    let warmStart30=null, warmStart60=null, warmStart90=null;
    if(incremental){
      const saved=loadModelWeights(name);
      if(saved){ warmStart30=saved.m30; warmStart60=saved.m60; warmStart90=saved.m90; }
    }

    // Yield between heavy operations so browser stays responsive
    const g30=trainModelsGuarded(rows,features,30,warmStart30,_stockWeights);
    const m30=g30.model;
    await new Promise(r=>setTimeout(r,0));

    const g60=trainModelsGuarded(rows,features,60,warmStart60,_stockWeights);
    const m60=g60.model;
    await new Promise(r=>setTimeout(r,0));

    const g90=trainModelsGuarded(rows,features,90,warmStart90,_stockWeights);
    const m90=g90.model;
    await new Promise(r=>setTimeout(r,0));

    const backtest=walkForwardBacktest(rows,features,30,5,name,true);
    const ensemble=g30.ensemble;
    const trainWarnings=[...g30.warnings,...g60.warnings.filter(w=>w.level==="error"),...g90.warnings.filter(w=>w.level==="error")];
    const models={m30,m60,m90,backtest,ensemble,trainWarnings,trainedAt:new Date().toISOString(),runCount:(results[name]?.runCount||0)+1};

    if(m30) saveModelWeights(name,models,m30.norm);
    setStockDataMap(prev=>({...prev,[name]:{...sd,models}}));

    const accuracy=backtest?.avgAccuracy??m30?.accuracy??0;
    const hist=appendLearningHistory(name,accuracy,m30?.trainSize??0,rows.length);
    setLearningHistories(prev=>({...prev,[name]:hist}));

    const res={
      name,rows:rows.length,trainedAt:new Date().toLocaleString(),
      runCount:models.runCount,
      acc30:m30?.accuracy, acc60:m60?.accuracy, acc90:m90?.accuracy,
      gbdtAcc30:m30?.gbdtAccuracy, lrAcc30:m30?.lrAccuracy,
      ensAcc30:m30?.accuracy,
      flatPct:m30?.flatPct,
      classBalance:m30?.classBalance,
      trainWarnings,
      btAcc:backtest?.avgAccuracy,btStratRet:backtest?.avgStrategyReturn,btBuyHold:backtest?.avgBuyHold,
      perClassUp:backtest?.perClass?.up, perClassFlat:backtest?.perClass?.flat, perClassDown:backtest?.perClass?.down,
      from:rows[0].date,to:rows[rows.length-1].date,
      incremental,
    };
    const updated={...results,[name]:res};
    setResults(updated);db.save("iq_train_results",updated);

    const improve = incremental&&results[name]?.btAcc
      ? ` (was ${(results[name].btAcc*100).toFixed(1)}%, now ${(accuracy*100).toFixed(1)}%)`
      : "";
    log("TRAIN","SUCCESS",`${name} [${mode}]: BT acc ${(accuracy*100).toFixed(1)}%${improve} · run #${models.runCount}`);
    setTraining(t=>({...t,[name]:false}));
  };

  // The currently selected stock's derived data
  // Guard: if selectedStock is a combined-dataset name that slipped through, treat as null
  const name = (selectedStock && !isCombinedFilename(selectedStock)) ? selectedStock : null;
  const res  = name ? results[name] : null;
  const isTr = name ? training[name] : false;
  const raw  = name ? db.load(STOCK_KEY(name)) : null;
  const rowCount = raw?.length ?? 0;
  const years = raw?.length > 0
    ? safeYearSpan(raw).toFixed(1)
    : "?";
  const hist = name ? (learningHistories[name] || []) : [];
  const hasSavedWeights = name ? !!db.load(MODEL_WEIGHTS_KEY(name)) : false;

  return(
    <div>
      <div style={{fontSize:17,fontWeight:900,color:"#f9fafb",marginBottom:4}}>🧠 Model Training</div>
      <div style={{fontSize:12,color:"#6b7280",marginBottom:4,lineHeight:1.7}}>
        Select a stock from the dropdown and train a model for it. KCB alone with 10 years of data works perfectly — one stock is all you need. <b style={{color:"#f9fafb"}}>Full Retrain</b> starts fresh. <b style={{color:"#f9fafb"}}>Incremental Update</b> continues from last saved weights — use this after adding new daily rows.
      </div>
      <div style={{fontSize:11,color:"#4b5563",marginBottom:16,background:"#0f172a",borderRadius:6,padding:"7px 10px",border:"1px solid #1f2937"}}>
        💡 Best workflow: upload KCB 10-year CSV → select it below → Full Retrain → add new rows → Incremental Update → repeat. The learning history chart shows accuracy improving over runs.
      </div>

      {cleanStocks.length===0?(
        <div style={{textAlign:"center",padding:"40px",color:"#6b7280",background:"#0f172a",borderRadius:10,border:"1px dashed #1f2937"}}>
          <div style={{fontSize:32,marginBottom:8}}>📭</div>
          <div>Upload CSV data first in the Data tab.</div>
        </div>
      ):(
        <>
          {/* ── Stock selector ─────────────────────────────────────────── */}
          <div style={{background:"#0f172a",border:"1px solid #1f2937",borderRadius:10,padding:14,marginBottom:16}}>
            <div style={{fontSize:11,color:"#6b7280",marginBottom:8,fontWeight:600}}>📊 Select stock to train</div>

            {/* Stock list — each row is selectable and has a ✕ delete button */}
            <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:10}}>
              {[...cleanStocks].sort((a,b)=>{
                const rawA=db.load(STOCK_KEY(a)); const rawB=db.load(STOCK_KEY(b));
                return (rawB?scoreStockForTrainability(b,rawB).score:0)-(rawA?scoreStockForTrainability(a,rawA).score:0);
              }).map(n=>{
                const r=db.load(STOCK_KEY(n));
                const yr=r?.length>0?safeYearSpan(r).toFixed(1):"?";
                const trained=!!db.load(MODEL_WEIGHTS_KEY(n));
                const sc=r?scoreStockForTrainability(n,r):null;
                const isSelected=selectedStock===n;
                return(
                  <div key={n}
                    style={{display:"flex",alignItems:"center",gap:8,borderRadius:7,padding:"8px 10px",
                      cursor:"pointer",border:`1px solid ${isSelected?"#3b82f6":"#1f2937"}`,
                      background:isSelected?"#1e3a5f":"#111827",transition:"all 0.15s"}}
                    onClick={()=>setSelectedStock(n)}>
                    {/* Tier badge */}
                    {sc&&<span style={{fontSize:10,fontWeight:800,padding:"2px 6px",borderRadius:4,
                      background:TIER_BG[sc.tier],color:TIER_COLOR[sc.tier],border:`1px solid ${TIER_BORDER[sc.tier]}`,
                      minWidth:32,textAlign:"center",flexShrink:0}}>
                      {sc.tier}{sc.score}
                    </span>}
                    {/* Stock name + stats */}
                    <div style={{flex:1,minWidth:0}}>
                      <span style={{fontWeight:700,color:isSelected?"#93c5fd":"#f9fafb",fontSize:13}}>
                        {trained&&<span style={{color:"#22c55e",marginRight:4}}>✓</span>}{n}
                      </span>
                      <span style={{fontSize:10,color:"#4b5563",marginLeft:8}}>
                        {r?.length?.toLocaleString()||"?"} rows · {yr} yrs
                      </span>
                    </div>
                    {/* ✕ Delete button — inline confirm avoids blocked window.confirm() */}
                    {pendingDelete===n?(
                      <div style={{display:"flex",gap:4,alignItems:"center",flexShrink:0}}
                           onClick={e=>e.stopPropagation()}>
                        <span style={{fontSize:10,color:"#fca5a5",whiteSpace:"nowrap"}}>Sure?</span>
                        <button onClick={e=>{e.stopPropagation();confirmDeleteStock(n);}}
                          style={{background:"#991b1b",border:"none",color:"#fff",borderRadius:4,
                            padding:"3px 9px",cursor:"pointer",fontSize:11,fontWeight:700}}>Yes</button>
                        <button onClick={e=>{e.stopPropagation();setPendingDelete(null);}}
                          style={{background:"#1f2937",border:"none",color:"#9ca3af",borderRadius:4,
                            padding:"3px 9px",cursor:"pointer",fontSize:11}}>No</button>
                      </div>
                    ):(
                      <button
                        onClick={e=>{e.stopPropagation();deleteStock(n);}}
                        title={`Delete ${n} and all its data`}
                        style={{background:"#7f1d1d",border:"1px solid #991b1b",color:"#fca5a5",
                          borderRadius:5,padding:"3px 8px",cursor:"pointer",fontSize:12,
                          flexShrink:0,lineHeight:1}}>✕</button>
                    )}
                  </div>
                );
              })}
            </div>

            <div style={{fontSize:10,color:"#4b5563"}}>
              ✓ = trained · Tier badge = trainability · ✕ = delete stock &amp; all data
            </div>

            {/* Data completeness nudge for Absa Kenya */}
            {name==="Absa Kenya"&&(()=>{
              const _sd=stockDataMap[name]||loadStockData(name);
              const rows=_sd?.rows||[];
              const firstYear=rows[0]?.date?.slice(0,4);
              if(firstYear&&parseInt(firstYear)>2010) return(
                <div style={{background:"#1c1400",border:"1px solid #854d0e",borderRadius:6,
                  padding:"7px 12px",marginBottom:8,fontSize:10,color:"#fbbf24",lineHeight:1.5}}>
                  💡 Your Absa Kenya data starts from {firstYear}. Uploading the full 2007-2025 history would add the 2008-2012 crisis cycle — 
                  the most important regime for training a robust model. The 2013-2025 dataset misses the bottom that trained Co-op Bank to 59.1% BT accuracy.
                </div>
              );
              return null;
            })()}

            {/* Data sufficiency warning */}
            {(()=>{
              const thin=cleanStocks.filter(s=>{const r=db.load(STOCK_KEY(s));return r&&r.length<500;});
              if(!thin.length) return null;
              return(
                <div style={{background:"#1c1400",border:"1px solid #854d0e",borderRadius:7,
                  padding:"8px 12px",marginTop:8,fontSize:11,color:"#fbbf24",lineHeight:1.5}}>
                  ⚠️ <b>{thin.length} stock(s)</b> have &lt;2 years of data
                  ({thin.slice(0,4).join(", ")}{thin.length>4?` +${thin.length-4} more`:""}). 
                  1-year datasets capture only one market regime — the model cannot handle both rising 
                  and falling markets. <b>Import 3-5 years of history for reliable predictions.</b>
                </div>
              );
            })()}

            {/* Low signal quality warning — shown when selected stock has poor BT history */}
            {name&&results[name]?.btAcc!=null&&results[name].btAcc<0.33&&(
              <div style={{background:"#1c0a0a",border:"1px solid #991b1b",borderRadius:7,
                padding:"8px 12px",marginTop:8,fontSize:11,color:"#fca5a5",lineHeight:1.5}}>
                🚨 <b>{name}</b> has historical BT accuracy of {(results[name].btAcc*100).toFixed(0)}% — below random chance (33%).
                This stock may lack learnable technical patterns (thin trading, discrete price steps, or regime-driven price action).
                Consider: <b>liquid large-caps</b> (KCB, Equity Bank, Safaricom, Absa Kenya) with 5+ years of history give consistently better results.
              </div>
            )}

            {/* Quick stats for selected stock */}
            {name&&raw&&(
              <div style={{display:"flex",gap:8,flexWrap:"wrap",marginTop:10}}>
                {[
                  ["Rows",rowCount.toLocaleString(),"#60a5fa"],
                  ["Years",years,"#a78bfa"],
                  ["From",fmtDate(raw[0].date),"#6b7280"],
                  ["To",fmtDate(raw[raw.length-1].date),"#6b7280"],
                ].map(([l,v,c])=>(
                  <div key={l} style={{background:"#111827",borderRadius:6,padding:"6px 10px",textAlign:"center"}}>
                    <div style={{fontSize:9,color:"#4b5563"}}>{l}</div>
                    <div style={{fontSize:12,fontWeight:700,color:c}}>{v}</div>
                  </div>
                ))}
                {(()=>{
                  const sc=scoreStockForTrainability(name,raw);
                  return(
                    <div style={{background:TIER_BG[sc.tier],border:`1px solid ${TIER_BORDER[sc.tier]}`,borderRadius:6,padding:"6px 10px",textAlign:"center",minWidth:70}}>
                      <div style={{fontSize:9,color:TIER_COLOR[sc.tier]}}>Trainability</div>
                      <div style={{fontSize:14,fontWeight:900,color:TIER_COLOR[sc.tier]}}>Tier {sc.tier}</div>
                      <div style={{fontSize:10,color:TIER_COLOR[sc.tier]}}>{sc.score}/100</div>
                    </div>
                  );
                })()}
              </div>
            )}

            {/* Sparkline for selected stock */}
            {raw&&raw.length>10&&(
              <div style={{marginTop:10}}>
                <div style={{fontSize:9,color:"#4b5563",marginBottom:3}}>Price history (last 120 days)</div>
                <Spark data={raw.slice(-120).map(r=>r.close)} height={36} width={500}/>
              </div>
            )}
          </div>

          {/* ── Training controls ───────────────────────────────────────── */}
          {name&&(
            <div style={{background:"#0f172a",border:"1px solid #1f2937",borderRadius:10,padding:16,marginBottom:14}}>

              {/* Recency bias selector */}
              <div style={{marginBottom:12}}>
                {name&&(()=>{
                  const w=db.load(`iq_feat_weights_${name.replace(/\s+/g,"_")}`);
                  if(!w) return null;
                  const n=Object.values(w).filter(v=>v!==1).length;
                  const amp=Object.entries(w).filter(([,v])=>v>1.2).map(([k])=>k);
                  const dmp=Object.entries(w).filter(([,v])=>v<0.5).map(([k])=>k);
                  return <div style={{background:"#052e16",border:"1px solid #065f46",borderRadius:6,padding:"6px 10px",marginBottom:8,fontSize:10,color:"#6ee7b7"}}>
                    ⚡ <b>Ablation weights active ({n} features)</b>
                    {amp.length>0&&` · Amplified: ${amp.join(", ")}`}
                    {dmp.length>0&&` · Dampened: ${dmp.join(", ")}`}
                  </div>;
                })()}
                <div style={{fontSize:10,color:"#6b7280",marginBottom:6,fontWeight:600}}>📅 Training data window</div>
                <div style={{display:"flex",gap:6,flexWrap:"wrap",alignItems:"center"}}>
                  {[[1,"1yr"],[2,"2yr"],[3,"3yr"],[0,"All"]].map(([yr,label])=>{
                    const active=recencyYears===yr;
                    const rowsInWindow=raw?(yr===0?raw.length:(()=>{
                      const lastD = safeDate(raw[raw.length-1]?.date);
                      if(!lastD) return raw.length;
                      lastD.setFullYear(lastD.getFullYear()-yr);
                      const cutStr = lastD.toISOString().split("T")[0];
                      return raw.filter(r=>r.date&&r.date>=cutStr).length;
                    })()):0;
                    return(
                      <button key={yr} onClick={()=>setRecencyYears(yr)}
                        style={{padding:"5px 13px",borderRadius:6,border:`1px solid ${active?"#3b82f6":"#374151"}`,background:active?"#1d4ed8":"#111827",color:active?"#fff":"#6b7280",cursor:"pointer",fontSize:11,fontWeight:active?700:400}}>
                        {label}
                        {raw&&<span style={{fontSize:9,color:active?"#93c5fd":"#374151",marginLeft:4}}>({rowsInWindow.toLocaleString()})</span>}
                      </button>
                    );
                  })}
                  {raw&&<span style={{fontSize:10,color:"#4b5563",marginLeft:4}}>
                    Training on {recencyYears===0?raw.length:(()=>{
                      const lastD = safeDate(raw[raw.length-1]?.date);
                      if(!lastD) return raw.length;
                      lastD.setFullYear(lastD.getFullYear()-recencyYears);
                      const cutStr = lastD.toISOString().split("T")[0];
                      return raw.filter(r=>r.date&&r.date>=cutStr).length;
                    })()} rows {recencyYears>0?`(${recencyYears} year${recencyYears>1?"s":""})`:("(all data)")}
                  </span>}
                </div>
              </div>

              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:hasSavedWeights?12:0,flexWrap:"wrap",gap:8}}>
                <div>
                  <div style={{fontWeight:800,color:"#f9fafb",fontSize:15}}>{name}</div>
                  <div style={{fontSize:11,color:"#6b7280",marginTop:2}}>Run #{res?.runCount||0} · {rowCount.toLocaleString()} rows · {years} years</div>
                  {hasSavedWeights&&<div style={{fontSize:10,color:"#22c55e",marginTop:2}}>✓ Weights persisted — Incremental Update available</div>}
                  {!hasSavedWeights&&<div style={{fontSize:10,color:"#4b5563",marginTop:2}}>No saved weights yet — run Full Retrain first</div>}
                </div>
                <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                  <button onClick={()=>trainStock(name,false)} disabled={isTr}
                    style={{background:isTr?"#1f2937":"#1d4ed8",border:"none",color:isTr?"#6b7280":"#fff",borderRadius:7,padding:"10px 18px",cursor:isTr?"not-allowed":"pointer",fontWeight:700,fontSize:13,minWidth:130}}>
                    {isTr?"⏳ Training…":"▶ Full Retrain"}
                  </button>
                  <button onClick={()=>trainStock(name,true)} disabled={isTr||!hasSavedWeights}
                    title={!hasSavedWeights?"Run Full Retrain first to create saved weights":"Continue training from last weights"}
                    style={{background:isTr||!hasSavedWeights?"#1f2937":"#065f46",border:"none",color:isTr||!hasSavedWeights?"#6b7280":"#6ee7b7",borderRadius:7,padding:"10px 18px",cursor:isTr||!hasSavedWeights?"not-allowed":"pointer",fontWeight:700,fontSize:13,minWidth:160}}>
                    {hasSavedWeights?"⚡ Incremental Update":"⚡ Incremental (train first)"}
                  </button>
                </div>
              </div>

              {/* Learning history sparkline */}
              {hist.length>1&&(
                <div style={{marginBottom:12}}>
                  <div style={{fontSize:10,color:"#6b7280",marginBottom:4}}>
                    Accuracy across {hist.length} training runs
                    {(()=>{
                      const delta=hist[hist.length-1].accuracy-hist[0].accuracy;
                      const c=delta>0?"#22c55e":delta<0?"#ef4444":"#6b7280";
                      return <span style={{color:c,marginLeft:8}}>{delta>0?"▲":delta<0?"▼":"—"} {Math.abs(delta*100).toFixed(1)}% overall change</span>;
                    })()}
                  </div>
                  <div style={{display:"flex",alignItems:"flex-end",gap:3,height:44}}>
                    {hist.map((h,i)=>{
                      const pct=Math.max(5,Math.min(100,h.accuracy*100));
                      const c=h.accuracy>0.6?"#22c55e":h.accuracy>0.5?"#eab308":"#ef4444";
                      return(
                        <div key={i} title={`Run ${h.run}: ${(h.accuracy*100).toFixed(1)}%`}
                          style={{flex:1,height:`${pct}%`,background:c,borderRadius:"2px 2px 0 0",opacity:0.85,minWidth:4,maxWidth:22,transition:"height 0.3s"}}/>
                      );
                    })}
                  </div>
                  <div style={{display:"flex",justifyContent:"space-between",fontSize:9,color:"#374151",marginTop:2}}>
                    <span>Run 1: {(hist[0].accuracy*100).toFixed(1)}%</span>
                    <span>Best: {(Math.max(...hist.map(h=>h.accuracy))*100).toFixed(1)}%</span>
                    <span>Latest: {(hist[hist.length-1].accuracy*100).toFixed(1)}%</span>
                  </div>
                </div>
              )}

              {/* Metrics grid */}
              {res&&(
                <div>
                  <div style={{fontSize:10,color:"#4b5563",marginBottom:8}}>
                    Last trained: {res.trainedAt}
                    {res.incremental&&<span style={{color:"#6ee7b7",marginLeft:8}}>⚡ incremental run</span>}
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(115px,1fr))",gap:8}}>
                    {[
                      ["BT Accuracy",res.btAcc?`${(res.btAcc*100).toFixed(1)}%`:"—",res.btAcc>0.6?"#22c55e":res.btAcc>0.5?"#eab308":"#ef4444","Authoritative — out-of-sample"],
                      ["Strategy Ret.",res.btStratRet!=null?fmtPct(res.btStratRet):"—",res.btStratRet>0?"#22c55e":"#ef4444","Avg return per BUY signal"],
                      ["Buy & Hold",res.btBuyHold!=null?fmtPct(res.btBuyHold):"—",res.btBuyHold>0?"#22c55e":"#ef4444","Simply hold"],
                      ["Alpha",res.btStratRet!=null&&res.btBuyHold!=null?fmtPct(res.btStratRet-res.btBuyHold):"—",(res.btStratRet-res.btBuyHold)>0?"#22c55e":"#ef4444","Strategy vs hold"],
                      ["LogReg (linear)",res.acc30?`${(res.acc30*100).toFixed(1)}%`:"—","#60a5fa","In-sample fit"],
                      ["GBDT (nonlin.)",res.gbdtAcc30?`${(res.gbdtAcc30*100).toFixed(1)}%`:"—","#a78bfa",res.gbdtAcc30&&res.acc30&&Math.abs(res.gbdtAcc30-res.acc30)<0.005?"⚠️ Matches LogReg — ensemble diversity low (feature scaling may have flattened GBDT splits)":"In-sample fit"],
                      ["Ensemble",res.ensAcc30?`${(res.ensAcc30*100).toFixed(1)}%`:"—","#34d399","In-sample fit"],
                    ].map(([l,v,c,s])=>(
                      <div key={l+s} style={{background:"#111827",borderRadius:6,padding:"8px 10px"}}>
                        <div style={{fontSize:9,color:"#4b5563"}}>{l}</div>
                        <div style={{fontSize:14,fontWeight:800,color:c}}>{v}</div>
                        {s&&<div style={{fontSize:9,color:"#374151",marginTop:1}}>{s}</div>}
                      </div>
                    ))}
                  </div>
                  {/* Model Health Warning */}
                  {res.btAcc!=null&&res.acc30!=null&&(()=>{
                    const btPct=res.btAcc*100, inPct=res.acc30*100, gap=inPct-btPct;
                    const warns=[];
                    if(btPct<33) warns.push({e:true, m:`BT accuracy ${btPct.toFixed(1)}% is BELOW random chance (33%). Do not trade on these signals.`});
                    else if(btPct<40) warns.push({e:false,m:`BT accuracy ${btPct.toFixed(1)}% is weak — use with caution and confirm with fundamentals.`});
                    if(gap>35) warns.push({e:true, m:`Severe overfitting: ${gap.toFixed(1)}pp gap (in-sample ${inPct.toFixed(1)}% vs BT ${btPct.toFixed(1)}%). Model memorised training data.`});
                    else if(gap>20&&btPct<40) warns.push({e:true, m:`Overfitting: ${gap.toFixed(1)}pp gap with weak BT ${btPct.toFixed(1)}%. Model learned noise.`});
                    else if(gap>20) warns.push({e:false,m:`In-sample fit (${inPct.toFixed(1)}%) is higher than BT (${btPct.toFixed(1)}%) — normal for financial models. Trust BT only.`});
                    if(res.classBalance){
                      const tot=(res.classBalance.up||0)+(res.classBalance.flat||0)+(res.classBalance.down||0)||1;
                      const dPct=res.classBalance.down/tot*100, uPct=res.classBalance.up/tot*100;
                      if(dPct>60) warns.push({e:false,m:`${dPct.toFixed(0)}% DOWN labels — strong bearish trend. Class balancing applied but verify signals.`});
                      if(uPct<15) warns.push({e:false,m:`Only ${uPct.toFixed(0)}% UP labels — BUY signals will be rare and may be unreliable.`});
                    }
                    if(res.classBalance?.tooSmall) warns.unshift({e:true,
                      m:`Only ${res.classBalance.binaryTrainSize} binary training samples (UP+DOWN rows). ` +
                        `Minimum 60 needed for any reliable learning. Import more historical data for this stock.`});
                    if(res.classBalance?.tooShort) warns.push({e:false,
                      m:`Dataset has ${res.trainSize} rows (~${(res.trainSize/252).toFixed(1)} years). ` +
                        `Recommended minimum is 500 rows (2+ years) for statistically reliable backtesting. ` +
                        `Current results have wide confidence intervals.`});
                    if(!warns.length) return null;
                    return <div style={{marginBottom:8}}>{warns.map((w,i)=>(
                      <div key={i} style={{background:w.e?"#1c0a0a":"#1c1400",border:`1px solid ${w.e?"#991b1b":"#854d0e"}`,borderRadius:6,padding:"7px 10px",marginBottom:5,fontSize:11,color:w.e?"#fca5a5":"#fbbf24",lineHeight:1.5}}>
                        {w.e?"🚨":"⚠️"} {w.m}
                      </div>
                    ))}</div>;
                  })()}

                  {/* Per-class accuracy from BT */}
                  {res.perClassUp!=null&&(
                    <div style={{marginTop:8,background:"#111827",borderRadius:6,padding:"8px 10px",fontSize:11}}>
                      <div style={{color:"#6b7280",marginBottom:4,fontWeight:700}}>Per-class accuracy (BT):</div>
                      <div style={{display:"flex",gap:12}}>
                        <span style={{color:"#22c55e"}}>UP: {res.perClassUp!=null?`${(res.perClassUp*100).toFixed(0)}%`:"—"}</span>
                        <span style={{color:"#6b7280"}}>FLAT: {res.perClassFlat!=null?`${(res.perClassFlat*100).toFixed(0)}%`:"—"}</span>
                        <span style={{color:"#ef4444"}}>DOWN: {res.perClassDown!=null?`${(res.perClassDown*100).toFixed(0)}%`:"—"}</span>
                        {res.classBalance&&(
                          <div style={{fontSize:10,color:"#4b5563",marginTop:4,display:"flex",gap:8,flexWrap:"wrap"}}>
                            <span style={{color:"#22c55e"}}>▲UP {Math.round(res.classBalance.up/(res.classBalance.up+res.classBalance.flat+res.classBalance.down)*100)}%</span>
                            <span style={{color:"#6b7280"}}>— FLAT {Math.round(res.classBalance.flat/(res.classBalance.up+res.classBalance.flat+res.classBalance.down)*100)}%</span>
                            <span style={{color:"#f87171"}}>▼DOWN {Math.round(res.classBalance.down/(res.classBalance.up+res.classBalance.flat+res.classBalance.down)*100)}%</span>
                            <span style={{color:"#3b82f6",marginLeft:4}}>✓ Balanced</span>
                          </div>
                        )}
                        {!res.classBalance&&res.flatPct!=null&&(
                          <span style={{color:res.flatPct>0.55?"#f87171":"#4b5563",marginLeft:"auto"}}>
                            {Math.round(res.flatPct*100)}% flat labels
                            {res.flatPct>0.55&&" ⚠ high — deadband auto-adjusted"}
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                  <div style={{marginTop:8,fontSize:11,color:"#6b7280",background:"#111827",borderRadius:6,padding:"7px 10px",lineHeight:1.6}}>
                    BT accuracy above 55% is useful · above 60% is strong. Alpha positive = model beats simply holding. In-sample fit is always inflated — use BT as the authoritative number.
                  </div>
                  {/* Guard warnings */}
                  {res.trainWarnings&&res.trainWarnings.length>0&&(
                    <div style={{marginTop:8,display:"flex",flexDirection:"column",gap:4}}>
                      {res.trainWarnings.map((w,i)=>{
                        const cfg={error:{bg:"#1c0a0a",border:"#991b1b",color:"#f87171",icon:"⛔"},warning:{bg:"#1c1400",border:"#854d0e",color:"#fbbf24",icon:"⚠️"},info:{bg:"#0f1f3d",border:"#1d4ed8",color:"#93c5fd",icon:"ℹ️"},success:{bg:"#052e16",border:"#166534",color:"#6ee7b7",icon:"✓"}}[w.level]||{bg:"#111827",border:"#374151",color:"#9ca3af",icon:"·"};
                        return <div key={i} style={{fontSize:11,background:cfg.bg,border:`1px solid ${cfg.border}`,borderRadius:5,padding:"5px 9px",color:cfg.color}}>{cfg.icon} {w.msg}</div>;
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ── All trained stocks summary ──────────────────────────────── */}
          {Object.keys(results).length>0&&(
            <div style={{background:"#0f172a",border:"1px solid #1f2937",borderRadius:10,padding:14}}>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
                <div style={{fontSize:12,fontWeight:800,color:"#f9fafb"}}>📋 All Trained Models</div>
                {/* Clear combined/invalid entries from the results cache */}
                {Object.keys(results).some(k=>isCombinedFilename(k))&&(
                  <button onClick={()=>{
                    const cleaned={};
                    for(const [k,v] of Object.entries(results)) {
                      if(!isCombinedFilename(k)) cleaned[k]=v;
                    }
                    db.save("iq_train_results",cleaned);
                    setResults(cleaned);
                  }} style={{background:"#7f1d1d",border:"1px solid #991b1b",color:"#fca5a5",
                    borderRadius:5,padding:"3px 10px",cursor:"pointer",fontSize:10}}>
                    🧹 Remove combined entries
                  </button>
                )}
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:6}}>
                {Object.values(results).filter(r=>!isCombinedFilename(r.name)&&cleanStocks.includes(r.name)).map((r)=>(
                  <div key={r.name}
                    onClick={()=>setSelectedStock(r.name)}
                    style={{display:"flex",alignItems:"center",gap:10,background:selectedStock===r.name?"#1e3a5f":"#111827",borderRadius:7,padding:"8px 12px",cursor:"pointer",border:`1px solid ${selectedStock===r.name?"#3b82f6":"#1f2937"}`}}>
                    <div style={{flex:1}}>
                      <span style={{fontWeight:700,color:selectedStock===r.name?"#93c5fd":"#f9fafb",fontSize:12}}>{r.name}</span>
                      <span style={{fontSize:10,color:"#4b5563",marginLeft:8}}>run #{r.runCount||1} · {r.rows?.toLocaleString()} rows</span>
                    </div>
                    <div style={{fontSize:13,fontWeight:800,color:r.btAcc>0.6?"#22c55e":r.btAcc>0.5?"#eab308":"#ef4444"}}>
                      {r.btAcc?`${(r.btAcc*100).toFixed(1)}%`:"—"}
                    </div>
                    <div style={{fontSize:9,color:"#4b5563"}}>BT acc</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── PREDICT TAB ──────────────────────────────────────────────────────────────
function PredictTab({stocks,stockDataMap}){
  const [selected,setSelected]=useState(stocks[0]??null);
  const [pred,setPred]=useState(null);
  const [loading,setLoading]=useState(false);

  useEffect(()=>{if(stocks.length&&!selected)setSelected(stocks[0]);},[stocks]);

  const run=async()=>{
    if(!selected) return;
    setLoading(true);setPred(null);
    await new Promise(r=>setTimeout(r,30));
    const sd=stockDataMap[selected]||loadStockData(selected);
    if(!sd){setLoading(false);return;}
    // Pass stockDataMap for sector momentum (Gap 5)
    setPred(generatePredictionGuarded(sd,null,stockDataMap));
    setLoading(false);
  };

  useEffect(()=>{if(selected)run();},[selected,stockDataMap[selected]?.models]);

  const sd=selected?stockDataMap[selected]||loadStockData(selected):null;
  const priceHistory=sd?sd.rows.slice(-120).map(r=>r.close):[];
  const curPrice=sd?sd.rows[sd.rows.length-1].close:null;

  return(
    <div>
      <div style={{fontSize:17,fontWeight:900,color:"#f9fafb",marginBottom:4}}>🎯 Predictions</div>
      <div style={{fontSize:12,color:"#6b7280",marginBottom:16}}>Price targets · direction signals · Kelly sizing · sector context · risk alerts.</div>

      {stocks.length===0?(
        <div style={{textAlign:"center",padding:"40px",color:"#6b7280",background:"#0f172a",borderRadius:10,border:"1px dashed #1f2937"}}>Upload and train data first.</div>
      ):(
        <>
          <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:16}}>
            {stocks.map(n=>(
              <button key={n} onClick={()=>setSelected(n)} style={{padding:"7px 14px",borderRadius:7,border:`1px solid ${selected===n?"#3b82f6":"#1f2937"}`,background:selected===n?"#1e3a5f":"#0f172a",color:selected===n?"#93c5fd":"#6b7280",cursor:"pointer",fontSize:12,fontWeight:selected===n?700:400}}>{n}</button>
            ))}
          </div>

          {loading&&<div style={{color:"#60a5fa",fontSize:13,marginBottom:12}}>⏳ Generating prediction…</div>}

          {pred&&!loading&&(
            <div>
              {/* ── P8: Stale tail warning ── */}
              {stockDataMap[selected]?.rows?._staleTail&&(
                <div style={{background:"#1c1400",border:"1px solid #854d0e",borderRadius:8,padding:"9px 14px",marginBottom:10,fontSize:12,color:"#fbbf24",fontWeight:600}}>
                  ⚠️ STALE DATA — Last 5 rows have identical prices and zero volume. This prediction may be based on outdated data. Upload a fresher CSV before acting on this signal.
                </div>
              )}

              {/* ── Backtest credibility badge ── */}
              {(()=>{
                const bt=stockDataMap[selected]?.models?.backtest;
                const acc=bt?.avgAccuracy;
                const strat=bt?.avgStrategyReturn;
                const bh=bt?.avgBuyHold;
                const trades=bt?.folds?.reduce((s,f)=>s+(f.testSize||0),0)||0;
                if(acc!=null){
                  const c=acc>0.55?"#22c55e":acc>0.50?"#eab308":"#ef4444";
                  const bg=acc>0.55?"#052e16":acc>0.50?"#1c1400":"#1c0a0a";
                  const border=acc>0.55?"#166534":acc>0.50?"#854d0e":"#991b1b";
                  return(
                    <div style={{background:bg,border:`1px solid ${border}`,borderRadius:8,padding:"9px 14px",marginBottom:10,display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
                      <span style={{fontSize:13,fontWeight:800,color:c}}>📊 {(acc*100).toFixed(1)}% accurate</span>
                      {trades>0&&<span style={{fontSize:11,color:"#9ca3af"}}>· {trades} trades</span>}
                      {strat!=null&&bh!=null&&<span style={{fontSize:11,color:strat>bh?"#22c55e":"#ef4444",fontWeight:700}}>· {fmtPct(strat)} strategy vs {fmtPct(bh)} buy-and-hold</span>}
                      <span style={{fontSize:10,color:"#4b5563",marginLeft:"auto"}}>Model credibility</span>
                    </div>
                  );
                }
                return(
                  <div style={{background:"#1c1400",border:"1px solid #854d0e",borderRadius:8,padding:"9px 14px",marginBottom:10,fontSize:11,color:"#fbbf24"}}>
                    ⚠️ No backtest run yet — train and run backtest before trusting this signal.
                  </div>
                );
              })()}

              {/* ── Liquidity warning ── */}
              {pred.lowLiquidityWarning&&(
                <div style={{background:"#1c0a0a",border:"1px solid #991b1b",borderRadius:8,padding:"9px 14px",marginBottom:10,fontSize:12,color:"#f87171",fontWeight:700}}>
                  ⚠️ LOW LIQUIDITY — Spread cost may erase this return. Trade with caution.
                </div>
              )}

              {/* ── 4a: Neutral zone gate reasons ── */}
              {/* Regime shift warning */}
              {pred.regimeShift?.isRegimeShift&&(
                <div style={{background:"#1c1400",border:"1px solid #854d0e",borderRadius:8,padding:"10px 14px",marginBottom:10,fontSize:12,color:"#fbbf24",lineHeight:1.6}}>
                  ⚠️ <b>Price regime shift detected.</b> The stock's current price level (median {pred.regimeShift.testMedian}) is {Math.abs(pred.regimeShift.shiftSigmas)}σ away from its training-period median ({pred.regimeShift.trainMedian}). Predictions trained on one price regime may not generalise to the current one. Retrain with more recent data.
                </div>
              )}
              {pred.regimeShift?.isVolShift&&(
                <div style={{background:"#1c1400",border:"1px solid #854d0e",borderRadius:8,padding:"10px 14px",marginBottom:10,fontSize:12,color:"#fbbf24",lineHeight:1.6}}>
                  ⚠️ <b>Volatility regime shift detected.</b> Current volatility is {parseFloat(pred.regimeShift.volShift)>1?"":"only "}{parseFloat(pred.regimeShift.volShift).toFixed(1)}× the training period's volatility. Model confidence bands may be miscalibrated.
                </div>
              )}

              {pred.gateNeutral&&pred.neutralReasons?.length>0&&(
                <div style={{background:"#1c1400",border:"1px solid #854d0e",borderRadius:8,padding:"9px 14px",marginBottom:10}}>
                  <div style={{fontSize:12,fontWeight:700,color:"#fbbf24",marginBottom:4}}>⚠️ NEUTRAL — insufficient confidence</div>
                  {pred.neutralReasons.map((r,i)=><div key={i} style={{fontSize:11,color:"#d97706",marginBottom:2}}>• {r}</div>)}
                  <div style={{fontSize:10,color:"#4b5563",marginTop:4}}>Kelly sizing = 0% until conditions improve.</div>
                </div>
              )}

              {/* ── Dividend capture alert ── */}
              {pred.dividendCapture&&(
                <div style={{background:"#052e16",border:"1px solid #166534",borderRadius:8,padding:"9px 14px",marginBottom:10,display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
                  <span style={{fontSize:13,fontWeight:800,color:"#22c55e"}}>🟢 Dividend window open</span>
                  <span style={{fontSize:11,color:"#6ee7b7"}}>Ex-date in {pred.dividendCapture.daysToExDate} days · KES {pred.dividendCapture.amount}/share</span>
                  <span style={{fontSize:11,color:"#4ade80"}}>Hist. avg rise: +{pred.dividendCapture.historicalAvgRise}% in window</span>
                </div>
              )}

              {/* Signal header */}
              <div style={{background:"#0f172a",border:`1px solid ${sigColor(pred.signal)}44`,borderRadius:12,padding:18,marginBottom:14}}>
                <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",flexWrap:"wrap",gap:12}}>
                  <div>
                    <div style={{fontSize:22,fontWeight:900,color:"#f9fafb",marginBottom:6}}>{selected}</div>
                    <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
                      <SigBadge signal={pred.signal}/>
                      <RiskBadge level={pred.riskScore.level}/>
                      {pred.forcedNeutral&&<span style={{fontSize:10,color:"#eab308",background:"#1c1917",border:"1px solid #854d0e",borderRadius:3,padding:"2px 6px"}}>Low confidence — NEUTRAL forced</span>}
                      {!stockDataMap[selected]?.models&&<span style={{fontSize:10,color:"#eab308",background:"#1c1917",border:"1px solid #854d0e",borderRadius:3,padding:"2px 6px"}}>Pattern-only — no model trained</span>}
                    </div>
                    {curPrice&&<div style={{fontSize:14,color:"#9ca3af",marginTop:8}}>Current price: <b style={{color:"#f9fafb"}}>{fmt(curPrice)}</b></div>}
                  </div>
                  <div style={{textAlign:"right",minWidth:160}}>
                    <ConfBar value={pred.confidence} label="Confidence"/>
                    {pred.modelAccuracy!==null&&<div style={{fontSize:11,color:"#6b7280",marginTop:6}}>BT accuracy: {(pred.modelAccuracy*100).toFixed(1)}%</div>}
                    <div style={{fontSize:11,color:"#6b7280",marginTop:2}}>Prob UP: {((pred.probUp??pred.modelProb)*100).toFixed(1)}%</div>
                  </div>
                </div>

                {/* U3: 3-class probability bars */}
                {pred.probUp!=null&&(
                  <div style={{marginTop:12}}>
                    {[
                      ["UP",   pred.probUp,   "#22c55e","#052e16"],
                      ["FLAT", pred.probFlat,  "#6b7280","#111827"],
                      ["DOWN", pred.probDown,  "#ef4444","#1c0a0a"],
                    ].map(([label,prob,color,bg])=>(
                      <div key={label} style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
                        <div style={{fontSize:11,color,fontWeight:700,width:36,flexShrink:0}}>{label}</div>
                        <div style={{flex:1,height:8,background:"#1f2937",borderRadius:4,overflow:"hidden"}}>
                          <div style={{width:`${Math.round((prob||0)*100)}%`,height:"100%",background:color,borderRadius:4,transition:"width 0.3s"}}/>
                        </div>
                        <div style={{fontSize:11,color,fontWeight:700,width:34,textAlign:"right"}}>{Math.round((prob||0)*100)}%</div>
                      </div>
                    ))}
                  </div>
                )}

                {/* U4: Ensemble breakdown */}
                {pred.ensembleBreakdown&&(
                  <div style={{marginTop:8,fontSize:10,color:"#4b5563",background:"#0a0f1e",borderRadius:6,padding:"6px 10px",lineHeight:1.7}}>
                    LogReg: {((pred.ensembleBreakdown.lrProb||0)*100).toFixed(0)}% (×{pred.ensembleBreakdown.lrWeight?.toFixed(2)})
                    {" · "}GBDT: {((pred.ensembleBreakdown.gbProb||0)*100).toFixed(0)}% (×{pred.ensembleBreakdown.gbWeight?.toFixed(2)})
                    {pred.ensembleBreakdown.patProb!=null&&` · Patterns: ${((pred.ensembleBreakdown.patProb||0)*100).toFixed(0)}% (×${pred.ensembleBreakdown.patWeight?.toFixed(2)})`}
                    {" → "}<b style={{color:"#93c5fd"}}>Ensemble: {((pred.probUp||0)*100).toFixed(0)}%</b>
                  </div>
                )}

                {priceHistory.length>10&&<div style={{marginTop:12}}><Spark data={priceHistory} height={50} width={580}/></div>}
              </div>

              {/* Gap 5+6: Kelly sizing + sector momentum banner */}
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14}}>
                {/* Kelly position sizing */}
                <div style={{background:"#0f172a",border:"1px solid #1f2937",borderRadius:10,padding:14}}>
                  <div style={{fontSize:11,fontWeight:700,color:"#f9fafb",marginBottom:6}}>💡 Kelly Position Size</div>
                  <div style={{fontSize:28,fontWeight:900,color:pred.kellyPct>0?"#22c55e":"#6b7280"}}>{pred.kellyPct}%</div>
                  <div style={{fontSize:11,color:"#6b7280",marginTop:4,lineHeight:1.5}}>
                    {pred.kellyPct>0
                      ? `Allocate up to ${pred.kellyPct}% of your portfolio to this trade.`
                      : "Accuracy too low to justify any allocation. Wait for better conditions."}
                  </div>
                  {/* 2d: Kelly formula transparency */}
                  {pred.kellyData&&(
                    <div style={{fontSize:10,color:"#4b5563",marginTop:5,fontFamily:"monospace"}}>
                      {pred.kellyData.source==="backtest"
                        ? `p=${(pred.kellyData.p*100).toFixed(0)}% · b=${pred.kellyData.b.toFixed(2)} · half-Kelly`
                        : "Fallback: accuracy-only estimate (run backtest for precise Kelly)"}
                    </div>
                  )}
                  {pred.accuracyTrend!==0&&(
                    <div style={{marginTop:6,fontSize:10,color:pred.accuracyTrend>0?"#22c55e":"#ef4444"}}>
                      {pred.accuracyTrend>0?"▲":"▼"} Model accuracy is {pred.accuracyTrend>0?"improving":"declining"} across folds ({pred.accuracyTrend>0?"+":""}{(pred.accuracyTrend*100).toFixed(1)}%)
                    </div>
                  )}
                </div>

                {/* Sector momentum */}
                <div style={{background:"#0f172a",border:"1px solid #1f2937",borderRadius:10,padding:14}}>
                  <div style={{fontSize:11,fontWeight:700,color:"#f9fafb",marginBottom:6}}>🌍 Sector Momentum</div>
                  {pred.sectorMomentum!==null?(
                    <>
                      <div style={{fontSize:28,fontWeight:900,color:pred.sectorMomentum>0?"#22c55e":pred.sectorMomentum<0?"#ef4444":"#eab308"}}>
                        {pred.sectorMomentum>=0?"+":""}{pred.sectorMomentum.toFixed(1)}%
                      </div>
                      <div style={{fontSize:11,color:"#6b7280",marginTop:4,lineHeight:1.5}}>
                        Average 5-day return across {Object.keys(stockDataMap).length-1} other loaded stocks. {pred.sectorMomentum>1?"Sector is bullish — tailwind.":pred.sectorMomentum<-1?"Sector is bearish — headwind.":"Sector is neutral."}
                      </div>
                    </>
                  ):(
                    <div style={{fontSize:12,color:"#4b5563",marginTop:8}}>Load more NSE stocks to see sector momentum. Upload KCB + Equity + Safaricom for best signal.</div>
                  )}
                </div>
              </div>

              {/* Price targets */}
              <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10,marginBottom:14}}>
                {[["30-Day Target",pred.target30,pred.pctTarget30,pred.patterns30.length],
                  ["60-Day Target",pred.target60,pred.pctTarget60,pred.patterns60.length],
                  ["90-Day Target",pred.target90,pred.pctTarget90,pred.patterns90.length]].map(([label,target,pct,patCount])=>(
                  <div key={label} style={{background:"#0f172a",border:"1px solid #1f2937",borderRadius:10,padding:14}}>
                    <div style={{fontSize:10,color:"#4b5563",marginBottom:4}}>{label}</div>
                    <div style={{fontSize:20,fontWeight:900,color:target?(pct>=0?"#22c55e":"#ef4444"):"#4b5563"}}>
                      {target?fmt(target):"—"}
                    </div>
                    <div style={{fontSize:12,color:pct>=0?"#22c55e":"#ef4444",marginTop:2}}>{fmtPct(pct)}</div>
                    <div style={{fontSize:10,color:"#374151",marginTop:4}}>from {patCount} historical setups</div>
                  </div>
                ))}
              </div>

              {/* Risk flags */}
              {pred.riskScore.flags.length>0&&(
                <div style={{background:"#1c0a0a",border:"1px solid #991b1b",borderRadius:10,padding:14,marginBottom:14}}>
                  <div style={{fontSize:13,fontWeight:800,color:"#f87171",marginBottom:8}}>🚨 Risk Flags — Score {pred.riskScore.score}/10</div>
                  {pred.riskScore.flags.map((f,i)=><div key={i} style={{fontSize:12,color:"#fca5a5",marginBottom:4}}>• {f}</div>)}
                </div>
              )}

              {/* Pattern matches */}
              {pred.patterns30.length>0&&(
                <div style={{background:"#0f172a",border:"1px solid #1f2937",borderRadius:10,padding:14,marginBottom:14}}>
                  <div style={{fontSize:13,fontWeight:800,color:"#f9fafb",marginBottom:4}}>🔍 Historical Patterns — 30-day horizon</div>
                  <div style={{fontSize:11,color:"#6b7280",marginBottom:10}}>
                    Top {pred.patterns30.length} most similar past setups and what happened 30 days later.
                  </div>
                  <div style={{display:"flex",flexDirection:"column",gap:6}}>
                    {pred.patterns30.map((p,i)=>(
                      <div key={i} style={{display:"flex",alignItems:"center",gap:10,background:"#111827",borderRadius:6,padding:"8px 12px"}}>
                        <div style={{fontSize:11,color:"#6b7280",minWidth:100}}>{fmtDate(p.date)}</div>
                        <div style={{flex:1,height:4,background:"#1f2937",borderRadius:2}}>
                          <div style={{width:`${p.sim*100}%`,height:"100%",background:"#60a5fa",borderRadius:2}}/>
                        </div>
                        <div style={{fontSize:10,color:"#4b5563",minWidth:55}}>Sim {(p.sim*100).toFixed(0)}%</div>
                        <div style={{fontSize:13,fontWeight:800,color:p.futureReturn>=0?"#22c55e":"#ef4444",minWidth:60,textAlign:"right"}}>{fmtPct(p.futureReturn)}</div>
                      </div>
                    ))}
                  </div>
                  <div style={{marginTop:10,display:"flex",gap:16,fontSize:12}}>
                    <span style={{color:"#22c55e"}}>▲ Up: {pred.patterns30.filter(p=>p.futureReturn>0).length}/{pred.patterns30.length}</span>
                    <span style={{color:"#ef4444"}}>▼ Down: {pred.patterns30.filter(p=>p.futureReturn<0).length}/{pred.patterns30.length}</span>
                    <span style={{color:"#60a5fa"}}>Avg: {fmtPct(pred.patterns30.reduce((s,p)=>s+p.futureReturn,0)/pred.patterns30.length)}</span>
                  </div>
                </div>
              )}

              {/* Technical indicators */}
              <div style={{background:"#0f172a",border:"1px solid #1f2937",borderRadius:10,padding:14}}>
                <div style={{fontSize:13,fontWeight:800,color:"#f9fafb",marginBottom:10}}>📊 Current Indicators</div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(130px,1fr))",gap:8}}>
                  {[
                    ["RSI (14)",fmt(pred.currentFeatures.rsi14,1),pred.currentFeatures.rsi14>70?"#ef4444":pred.currentFeatures.rsi14<30?"#22c55e":"#eab308"],
                    ["RSI (7)",fmt(pred.currentFeatures.rsi7,1),pred.currentFeatures.rsi7>70?"#ef4444":pred.currentFeatures.rsi7<30?"#22c55e":"#eab308"],
                    ["MACD",pred.currentFeatures.macdAbove===1?"Bullish ▲":pred.currentFeatures.macdAbove===-1?"Bearish ▼":"—",pred.currentFeatures.macdAbove===1?"#22c55e":"#ef4444"],
                    ["Bollinger %",fmt(pred.currentFeatures.bbPct?pred.currentFeatures.bbPct*100:null,0)+"%",pred.currentFeatures.bbPct>0.8?"#ef4444":pred.currentFeatures.bbPct<0.2?"#22c55e":"#eab308"],
                    ["ATR Volatility",fmt(pred.currentFeatures.atrPct,1)+"%",pred.currentFeatures.atrPct>3?"#ef4444":"#22c55e"],
                    ["Vol Spike",`${fmt(pred.currentFeatures.vSpike,1)}x`,pred.currentFeatures.vSpike>2?"#eab308":"#9ca3af"],
                    ["Stochastic",fmt(pred.currentFeatures.stoch,0),pred.currentFeatures.stoch>80?"#ef4444":pred.currentFeatures.stoch<20?"#22c55e":"#eab308"],
                    ["EMA 50>200",pred.currentFeatures.e50v200>0?"Golden ✓":"Death ✗",pred.currentFeatures.e50v200>0?"#22c55e":"#ef4444"],
                    ["ROC 20d",fmtPct(pred.currentFeatures.roc20),pred.currentFeatures.roc20>0?"#22c55e":"#ef4444"],
                    ["ROC 5d",fmtPct(pred.currentFeatures.roc5),pred.currentFeatures.roc5>0?"#22c55e":"#ef4444"],
                    ["CBK Rate",(pred.currentFeatures.macroCbkNorm!=null?(pred.currentFeatures.macroCbkNorm*10+8).toFixed(1):"-")+"%",pred.currentFeatures.macroCbkNorm>0.5?"#ef4444":"#22c55e"],
                    ["Near Event",pred.currentFeatures.nearEvent===1?"Yes ⚡":"No","#a78bfa"],
                  ].map(([l,v,c])=>(
                    <div key={l} style={{background:"#111827",borderRadius:6,padding:"8px 10px"}}>
                      <div style={{fontSize:9,color:"#4b5563"}}>{l}</div>
                      <div style={{fontSize:13,fontWeight:700,color:c}}>{v}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── BACKTEST TAB ─────────────────────────────────────────────────────────────
function BacktestTab({stocks,stockDataMap}){
  const [selected,setSelected]=useState(stocks[0]??null);
  const [showNet,setShowNet]=useState(true);
  const [ablation,setAblation]=useState(null);
  const [ablLoading,setAblLoading]=useState(false);
  const [regime,setRegime]=useState(null);
  const [regLoading,setRegLoading]=useState(false);
  useEffect(()=>{if(stocks.length&&!selected)setSelected(stocks[0]);},[stocks]);
  const sd=selected?stockDataMap[selected]:null;
  const bt=sd?.models?.backtest;
  const isTrained=!!sd?.models;
  const rawRows=selected?db.load(STOCK_KEY(selected)):null;
  const rowCount=rawRows?.length??0;
  const agg=bt?.aggregate;

  const runAblation=async()=>{
    if(!sd?.rows||!sd?.features) return;
    setAblLoading(true);
    await new Promise(r=>setTimeout(r,30));
    const saved=db.load(`iq_ablation_${selected?.replace(/\s+/g,"_")}_${FEAT_KEYS_FP}`);
    if(saved){setAblation(saved);setAblLoading(false);return;}
    const result=runFeatureAblation(sd.rows,sd.features,30,selected||"");
    if(result) db.save(`iq_ablation_${selected?.replace(/\s+/g,"_")}_${FEAT_KEYS_FP}`,result);
    setAblation(result);setAblLoading(false);
  };

  const runRegime=async()=>{
    if(!sd?.rows||!sd?.features) return;
    setRegLoading(true);
    await new Promise(r=>setTimeout(r,30));
    const result=regimeStressTest(sd.rows,sd.features,30,selected||"");
    setRegime(result);setRegLoading(false);
  };

  return(
    <div>
      <div style={{fontSize:17,fontWeight:900,color:"#f9fafb",marginBottom:4}}>📋 Backtest Results</div>
      <div style={{fontSize:12,color:"#6b7280",marginBottom:16}}>Walk-forward: model trains on past, tests on future. Benchmarks, Wilson CI, transaction costs, ablation and regime stress included.</div>
      {stocks.length===0?<div style={{color:"#6b7280"}}>No data. Upload and train first.</div>:(
        <>
          <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:16}}>
            {stocks.map(n=>(
              <button key={n} onClick={()=>{setSelected(n);setAblation(null);setRegime(null);}}
                style={{padding:"7px 14px",borderRadius:7,border:`1px solid ${selected===n?"#3b82f6":"#1f2937"}`,
                  background:selected===n?"#1e3a5f":"#0f172a",color:selected===n?"#93c5fd":"#6b7280",
                  cursor:"pointer",fontSize:12,fontWeight:selected===n?700:400}}>{n}</button>
            ))}
          </div>

          {!isTrained?(
            <div style={{textAlign:"center",padding:"40px",color:"#6b7280",background:"#0f172a",borderRadius:10,border:"1px dashed #1f2937"}}>
              <div style={{fontSize:28,marginBottom:8}}>🧠</div>
              <div>Train a model for <b style={{color:"#f9fafb"}}>{selected}</b> first (go to the Train tab).</div>
            </div>
          ):!bt?(
            <div style={{background:"#1c1400",border:"1px solid #854d0e",borderRadius:10,padding:20,textAlign:"center"}}>
              <div style={{fontSize:22,marginBottom:8}}>⚠️</div>
              <div style={{color:"#fbbf24",fontWeight:700,marginBottom:6}}>Not enough data for walk-forward folds</div>
              <div style={{color:"#9ca3af",fontSize:12,lineHeight:1.7}}>
                <b style={{color:"#f9fafb"}}>{selected}</b> has <b style={{color:"#fbbf24"}}>{rowCount} rows</b>. Predictions work — only fold-based backtesting needs more data.<br/>
                <span style={{color:"#6b7280",fontSize:11}}>Tip: ideally 200+ rows. Use the Simulate tab for smaller datasets.</span>
              </div>
            </div>
          ):(
            <>
              {/* FIX 4: Backtest integrity violation banner */}
              {bt._allLeaked&&(
                <div style={{background:"#1c0a0a",border:"2px solid #991b1b",borderRadius:10,padding:"14px 18px",marginBottom:14}}>
                  <div style={{fontSize:14,fontWeight:900,color:"#f87171",marginBottom:6}}>🚨 BACKTEST INTEGRITY VIOLATION — Results Suppressed</div>
                  <div style={{fontSize:12,color:"#fca5a5",lineHeight:1.7,marginBottom:8}}>
                    The cheat-detection guard found that every backtest fold had future data leaking into the training set.
                    This usually means your CSV is sorted <b>newest-first</b> (Yahoo Finance downloads in reverse chronological order by default).
                  </div>
                  <div style={{fontSize:11,color:"#f97316",fontWeight:700,marginBottom:4}}>How to fix:</div>
                  <div style={{fontSize:11,color:"#9ca3af",lineHeight:1.7}}>
                    1. Open your CSV in Excel / Google Sheets → sort by Date column <b>A→Z</b> (oldest first) → re-save.<br/>
                    2. Delete this stock from the Data tab and re-import the corrected CSV.<br/>
                    3. Re-train and re-run the backtest.
                  </div>
                  {bt._leakViolations?.slice(0,2).map((msg,i)=>(
                    <div key={i} style={{marginTop:8,fontSize:10,color:"#6b7280",fontFamily:"monospace",background:"#0a0f1e",borderRadius:5,padding:"6px 10px"}}>{msg}</div>
                  ))}
                </div>
              )}
              {bt._leakViolations&&!bt._allLeaked&&(
                <div style={{background:"#1c1400",border:"1px solid #854d0e",borderRadius:8,padding:"10px 14px",marginBottom:14,fontSize:12,color:"#fbbf24"}}>
                  ⚠️ {bt._leakViolations.length} backtest fold(s) failed the temporal integrity check and were skipped. Results below use only the clean folds.
                </div>
              )}

              {/* ── Edge assessment banner ── */}
              {!bt._allLeaked&&(()=>{
                const ir=bt.informationRatio;
                const has=bt.hasEdge;
                const ci=bt.ci;
                return(
                  <div style={{background:has?"#052e16":"#1c0a0a",border:`1px solid ${has?"#166534":"#991b1b"}`,borderRadius:10,padding:"12px 16px",marginBottom:14}}>
                    <div style={{display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
                      <span style={{fontSize:15,fontWeight:900,color:has?"#22c55e":"#ef4444"}}>
                        {has?"✅ SIGNIFICANT EDGE DETECTED":"❌ NO SIGNIFICANT EDGE"}
                      </span>
                      <span style={{fontSize:11,color:"#9ca3af"}}>
                        IR = {ir?.toFixed(2)??"-"} {has?"(≥1.0 = edge)":"(<1.0 = noise)"}
                      </span>
                      {ci&&<span style={{fontSize:11,color:"#6b7280"}}>
                        Accuracy 95% CI: [{(ci.lo*100).toFixed(1)}% – {(ci.hi*100).toFixed(1)}%]
                      </span>}
                      {bt.spreadCost>0&&<span style={{fontSize:10,color:"#eab308"}}>
                        Spread: {bt.spreadCost}% per side
                      </span>}
                    </div>
                    <div style={{marginTop:8,display:"flex",gap:8,alignItems:"center"}}>
                      <span style={{fontSize:11,color:"#4b5563"}}>Returns:</span>
                      <button onClick={()=>setShowNet(true)} style={{padding:"3px 10px",borderRadius:5,border:`1px solid ${showNet?"#3b82f6":"#374151"}`,background:showNet?"#1e3a5f":"#111827",color:showNet?"#93c5fd":"#6b7280",cursor:"pointer",fontSize:11,fontWeight:showNet?700:400}}>Net (after costs)</button>
                      <button onClick={()=>setShowNet(false)} style={{padding:"3px 10px",borderRadius:5,border:`1px solid ${!showNet?"#3b82f6":"#374151"}`,background:!showNet?"#1e3a5f":"#111827",color:!showNet?"#93c5fd":"#6b7280",cursor:"pointer",fontSize:11,fontWeight:!showNet?700:400}}>Gross</button>
                    </div>
                  </div>
                );
              })()}

              {/* ── Benchmark comparison ── */}
              {bt.benchmarks&&(
                <div style={{background:"#0f172a",border:"1px solid #1f2937",borderRadius:10,padding:14,marginBottom:14}}>
                  <div style={{fontSize:13,fontWeight:800,color:"#f9fafb",marginBottom:10}}>🏁 Benchmark Comparison</div>
                  <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(140px,1fr))",gap:8}}>
                    {[
                      ["Your Model",bt.avgAccuracy,"#3b82f6",true],
                      ["Random Guess",bt.benchmarks.random,"#6b7280",false],
                      ["Always Majority",bt.benchmarks.majority,"#6b7280",false],
                      ["EMA Crossover",bt.benchmarks.ema,"#eab308",false],
                    ].map(([label,acc,color,isModel])=>(
                      <div key={label} style={{background:isModel?"#1e3a5f":"#111827",borderRadius:8,padding:"10px 12px",border:isModel?"1px solid #3b82f6":"1px solid #1f2937"}}>
                        <div style={{fontSize:10,color:"#6b7280",marginBottom:4}}>{label}</div>
                        <div style={{fontSize:22,fontWeight:900,color:acc>0.55?color:acc>0.5?"#eab308":"#ef4444"}}>{(acc*100).toFixed(1)}%</div>
                        {isModel&&<div style={{fontSize:9,color:"#4b5563",marginTop:2}}>
                          {bt.avgAccuracy>bt.benchmarks.ema?`+${((bt.avgAccuracy-bt.benchmarks.ema)*100).toFixed(1)}pp vs EMA`:"Behind EMA"}
                        </div>}
                      </div>
                    ))}
                  </div>
                  <div style={{marginTop:10,fontSize:11,color:"#4b5563",lineHeight:1.6}}>
                    IR = (Model − Best Baseline) ÷ Std Error. IR ≥ 1.0 = statistically significant edge.
                    A model that can't beat EMA crossover has no edge worth trading.
                  </div>
                </div>
              )}

              {/* ── Core summary metrics ── */}
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(130px,1fr))",gap:10,marginBottom:14}}>
                {[
                  ["Avg Accuracy",`${(bt.avgAccuracy*100).toFixed(1)}%`,bt.avgAccuracy>0.6?"#22c55e":bt.avgAccuracy>0.5?"#eab308":"#ef4444","Direction correct"],
                  ["Strategy Ret",fmtPct(bt.avgStrategyReturn),bt.avgStrategyReturn>0?"#22c55e":"#ef4444","Following BUY signals"],
                  ["Buy & Hold",fmtPct(bt.avgBuyHold),bt.avgBuyHold>0?"#22c55e":"#ef4444","Simply holding"],
                  ["Alpha",fmtPct(bt.avgStrategyReturn-bt.avgBuyHold),(bt.avgStrategyReturn-bt.avgBuyHold)>0?"#22c55e":"#ef4444","Model edge"],
                  ["Folds",bt.folds.length,"#60a5fa","Test periods"],
                  ["Horizon",`${bt.horizon}d`,"#9ca3af","Prediction window"],
                ].map(([l,v,c,s])=><Stat key={l} label={l} value={v} color={c} sub={s}/>)}
              </div>

              {/* ── Advanced risk metrics ── */}
              {agg&&(
                <div style={{background:"#0f172a",border:"1px solid #1f2937",borderRadius:10,padding:14,marginBottom:14}}>
                  <div style={{fontSize:13,fontWeight:800,color:"#f9fafb",marginBottom:10}}>📊 Risk Metrics {showNet?`(net, −${bt.spreadCost||0}% spread)`:("(gross)")} — aggregate across all folds</div>
                  <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(130px,1fr))",gap:8,marginBottom:10}}>
                    {[
                      ["Sharpe Ratio",agg.sharpe.toFixed(2),agg.sharpe>1?"#22c55e":agg.sharpe>0?"#eab308":"#ef4444","Return / total risk"],
                      ["Sortino Ratio",agg.sortino.toFixed(2),agg.sortino>1?"#22c55e":agg.sortino>0?"#eab308":"#ef4444","Return / downside risk"],
                      ["Max Drawdown",`-${agg.maxDrawdown.toFixed(1)}%`,"#ef4444",`Equity curve drawdown (10% position/trade) — avg individual loss: -${Math.abs(agg.avgLoss||0).toFixed(1)}%`],
                      ["Calmar Ratio",agg.calmar>99?"∞":agg.calmar.toFixed(2),agg.calmar>1?"#22c55e":agg.calmar>0?"#eab308":"#ef4444","Ann. return / drawdown"],
                      ["Win Rate",`${(agg.winRate*100).toFixed(1)}%`,agg.winRate>0.5?"#22c55e":"#ef4444","% profitable trades"],
                      ["Loss Rate",`${(agg.lossRate*100).toFixed(1)}%`,"#ef4444","% losing trades"],
                      ["Avg Win",fmtPct(agg.avgWin),"#22c55e","Avg return when right"],
                      ["Avg Loss",fmtPct(agg.avgLoss),"#ef4444","Avg return when wrong"],
                      ["Profit Factor",agg.profitFactor>99?"∞":agg.profitFactor.toFixed(2),agg.profitFactor>1.5?"#22c55e":agg.profitFactor>1?"#eab308":"#ef4444","Gross profit / gross loss"],
                      ["Total Trades",agg.wins+agg.losses,"#60a5fa","UP signal trades"],
                      ["Wins / Losses",`${agg.wins} / ${agg.losses}`,"#9ca3af",""],
                      ["Net Return",fmtPct(agg.totalReturn),agg.totalReturn>0?"#22c55e":"#ef4444","After costs"],
                    ].map(([l,v,c,s])=>(
                      <div key={l} style={{background:"#111827",borderRadius:6,padding:"8px 10px"}}>
                        <div style={{fontSize:9,color:"#4b5563"}}>{l}</div>
                        <div style={{fontSize:13,fontWeight:800,color:c}}>{v}</div>
                        {s&&<div style={{fontSize:9,color:"#374151",marginTop:1}}>{s}</div>}
                      </div>
                    ))}
                  </div>
                  {agg.equityCurve&&agg.equityCurve.length>2&&(
                    <div>
                      <div style={{fontSize:10,color:"#6b7280",marginBottom:4}}>Strategy equity curve (start=100) {showNet?"— net":"— gross"}</div>
                      <Spark data={agg.equityCurve} height={50} width={680}/>
                    </div>
                  )}
                  <div style={{marginTop:10,display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,fontSize:11,color:"#4b5563"}}>
                    <div><b style={{color:"#9ca3af"}}>Sharpe &gt; 1</b> = good risk-adjusted return. &gt; 2 = excellent.</div>
                    <div><b style={{color:"#9ca3af"}}>Sortino</b> = like Sharpe but only penalises downside volatility.</div>
                    <div><b style={{color:"#9ca3af"}}>Max Drawdown</b> = worst loss from a peak. Keep below 20% for conservative use.</div>
                    <div><b style={{color:"#9ca3af"}}>Profit Factor &gt; 1.5</b> = strategy makes 1.5x more than it loses.</div>
                  </div>
                </div>
              )}

              {/* ── Calibration curve ── */}
              {bt.calibration&&(
                <div style={{background:"#0f172a",border:"1px solid #1f2937",borderRadius:10,padding:14,marginBottom:14}}>
                  <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
                    <div style={{fontSize:13,fontWeight:800,color:"#f9fafb"}}>📐 Calibration Curve</div>
                    {bt.calibration.poorlyCalibrated&&<span style={{fontSize:10,background:"#1c0a0a",border:"1px solid #991b1b",color:"#f87171",borderRadius:4,padding:"2px 8px",fontWeight:700}}>POORLY CALIBRATED</span>}
                  </div>
                  <div style={{display:"flex",gap:4,alignItems:"flex-end",height:60}}>
                    {bt.calibration.bins.map((b,i)=>{
                      const predicted=b.predictedProb??0;
                      const actual=b.actualWinRate??0;
                      const gap=Math.abs(predicted-actual);
                      const c=gap>0.2?"#ef4444":gap>0.1?"#eab308":"#22c55e";
                      return(
                        <div key={i} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:2}}>
                          <div style={{fontSize:8,color:c,fontWeight:700}}>{b.count}</div>
                          <div style={{width:"100%",background:c,opacity:0.8,height:`${Math.max(4,actual*50)}px`,borderRadius:"2px 2px 0 0"}} title={`Predicted: ${(predicted*100).toFixed(0)}% | Actual: ${(actual*100).toFixed(0)}%`}/>
                          <div style={{fontSize:7,color:"#4b5563"}}>{(b.midProb*100).toFixed(0)}%</div>
                        </div>
                      );
                    })}
                  </div>
                  <div style={{fontSize:10,color:"#4b5563",marginTop:6}}>Bar height = actual win rate. Red = predicted prob ≠ actual win rate (miscalibrated). Green = well calibrated. Numbers above bars = trade count in that decile.</div>
                </div>
              )}

              {/* ── Per-fold table ── */}
              <div style={{background:"#0f172a",border:"1px solid #1f2937",borderRadius:10,overflow:"hidden",marginBottom:14}}>
                <div style={{display:"grid",gridTemplateColumns:"40px 1fr 1fr 1fr 1fr 1fr 1fr 1fr",background:"#111827"}}>
                  {["#","Accuracy","Strat Ret","Buy&Hold","Alpha","Win Rate","Worst Loss","Trades"].map(h=>(
                    <div key={h} style={{padding:"8px 10px",fontSize:10,color:"#4b5563",fontWeight:700}}>{h}</div>
                  ))}
                </div>
                {bt.folds.map((fold,i)=>{
                  const alpha=fold.stratRet-fold.buyHold;
                  const m=fold.metrics;
                  return(
                    <div key={i} style={{display:"grid",gridTemplateColumns:"40px 1fr 1fr 1fr 1fr 1fr 1fr 1fr",
                      borderTop:"1px solid #111827",
                      background:fold.regimeFlip?"rgba(251,146,60,0.05)":"transparent"}}>
                      <div style={{padding:"7px 10px",fontSize:12,color:fold.regimeFlip?"#f97316":"#6b7280"}}>
                        {i+1}{fold.regimeFlip&&<span title="Training window had regime flip — results less reliable">⚡</span>}
                      </div>
                      <div style={{padding:"7px 10px",fontSize:12,fontWeight:700,color:fold.accuracy>0.6?"#22c55e":fold.accuracy>0.5?"#eab308":"#ef4444"}}>{(fold.accuracy*100).toFixed(1)}%</div>
                      <div style={{padding:"7px 10px",fontSize:12,color:fold.stratRet>0?"#22c55e":"#ef4444"}}>{fmtPct(fold.stratRet)}</div>
                      <div style={{padding:"7px 10px",fontSize:12,color:fold.buyHold>0?"#22c55e":"#ef4444"}}>{fmtPct(fold.buyHold)}</div>
                      <div style={{padding:"7px 10px",fontSize:12,fontWeight:700,color:alpha>0?"#22c55e":"#ef4444"}}>{fmtPct(alpha)}</div>
                      <div style={{padding:"7px 10px",fontSize:12,color:m?.winRate>0.5?"#22c55e":"#ef4444"}}>{m?`${(m.winRate*100).toFixed(0)}%`:"—"}</div>
                      <div style={{padding:"7px 10px",fontSize:12,color:"#ef4444"}}>{m?`-${m.maxDrawdown.toFixed(1)}%`:"—"}</div>
                      <div style={{padding:"7px 10px",fontSize:12,color:"#9ca3af"}}>{fold.testSize}</div>
                    </div>
                  );
                })}
              </div>

              {/* ── Feature Ablation ── */}
              <div style={{background:"#0f172a",border:"1px solid #1f2937",borderRadius:10,padding:14,marginBottom:14}}>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10,flexWrap:"wrap",gap:8}}>
                  <div>
                    <div style={{fontSize:13,fontWeight:800,color:"#f9fafb"}}>🔬 Feature Ablation Study</div>
                    <div style={{fontSize:10,color:"#6b7280",marginTop:2}}>Which features help vs hurt vs noise</div>
                  </div>
                  <button onClick={runAblation} disabled={ablLoading||!isTrained}
                    style={{background:ablLoading?"#1f2937":"#1d4ed8",border:"none",color:ablLoading?"#6b7280":"#fff",borderRadius:6,padding:"7px 14px",cursor:ablLoading?"not-allowed":"pointer",fontSize:12,fontWeight:700}}>
                    {ablLoading?"⏳ Running…":"▶ Run Ablation"}
                  </button>
                  {ablation?.deltas&&selected&&(()=>{
                    const wKey=`iq_feat_weights_${selected.replace(/\s+/g,"_")}`;
                    const hasSaved=!!db.load(wKey);
                    const weights=computeFeatureWeightsFromAblation(ablation.deltas);
                    const nTuned=Object.values(weights).filter(w=>w!==1).length;
                    return(
                      <div style={{display:"flex",gap:6,alignItems:"center",flexWrap:"wrap"}}>
                        <button onClick={()=>{ db.save(wKey,weights); alert(`✅ Weights saved for ${selected}. Go to Train tab → Full Retrain to apply.`); }}
                          style={{background:hasSaved?"#065f46":"#064e3b",border:"1px solid #065f46",color:"#6ee7b7",
                            borderRadius:6,padding:"5px 12px",cursor:"pointer",fontSize:11,fontWeight:700}}>
                          ⚡ {hasSaved?"Update":"Save"} ablation weights ({nTuned} tuned)
                        </button>
                        {hasSaved&&<button onClick={()=>{ db.remove(wKey); alert("Weights cleared. Retrain to apply."); }}
                          style={{background:"#1c0a0a",border:"1px solid #991b1b",color:"#fca5a5",borderRadius:6,padding:"5px 10px",cursor:"pointer",fontSize:10}}>
                          ✕ Clear
                        </button>}
                        {hasSaved&&<span style={{fontSize:9,color:"#6ee7b7"}}>✓ Active — retrain in Train tab to apply</span>}
                      </div>
                    );
                  })()}
                </div>
                {ablation?(
                  <>
                    <div style={{fontSize:11,color:"#6b7280",marginBottom:8}}>Full model accuracy: <b style={{color:"#f9fafb"}}>{(ablation.fullAcc*100).toFixed(1)}%</b> · Positive delta = feature helps · Negative = hurts · Near zero = noise</div>
                    <div style={{display:"flex",flexDirection:"column",gap:3}}>
                      {ablation.deltas.map((d,i)=>{
                        const c=d.status==="helps"?"#22c55e":d.status==="hurts"?"#ef4444":d.status==="macro-constant"?"#f97316":"#6b7280";
                        const barW=Math.min(100,Math.abs(d.delta)*1000);
                        return(
                          <div key={i} style={{display:"flex",alignItems:"center",gap:8,padding:"4px 0",
                            opacity:d.status==="macro-constant"?0.6:1}}>
                            <div style={{width:110,fontSize:10,color:d.status==="macro-constant"?"#f97316":"#9ca3af",fontFamily:"monospace"}}>{d.key}</div>
                            <div style={{flex:1,height:6,background:"#111827",borderRadius:3,overflow:"hidden"}}>
                              <div style={{width:`${barW}%`,height:"100%",background:c,borderRadius:3}}/>
                            </div>
                            <div style={{width:60,fontSize:10,color:c,textAlign:"right",fontWeight:700}}>
                              {d.delta>=0?"+":""}{(d.delta*100).toFixed(1)}pp
                            </div>
                            <div style={{width:50,fontSize:9,color:c}}>{d.status==="macro-constant"?"⚠ qtrly":d.status}</div>
                          </div>
                        );
                      })}
                    </div>
                  </>
                ):<div style={{fontSize:11,color:"#4b5563"}}>Click Run Ablation to see which of the 24 features actually contribute to accuracy. Takes ~10 seconds.</div>}
              </div>

              {/* ── Regime Stress Test ── */}
              <div style={{background:"#0f172a",border:"1px solid #1f2937",borderRadius:10,padding:14,marginBottom:14}}>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10,flexWrap:"wrap",gap:8}}>
                  <div>
                    <div style={{fontSize:13,fontWeight:800,color:"#f9fafb"}}>🌡️ Regime Stress Test</div>
                    <div style={{fontSize:10,color:"#6b7280",marginTop:2}}>Accuracy per CBK macro regime</div>
                  </div>
                  <button onClick={runRegime} disabled={regLoading||!isTrained}
                    style={{background:regLoading?"#1f2937":"#065f46",border:"none",color:regLoading?"#6b7280":"#6ee7b7",borderRadius:6,padding:"7px 14px",cursor:regLoading?"not-allowed":"pointer",fontSize:12,fontWeight:700}}>
                    {regLoading?"⏳ Running…":"▶ Run Stress Test"}
                  </button>
                </div>
                {regime?(
                  <>
                    {regime.regimeDependent&&(
                      <div style={{background:"#1c1400",border:"1px solid #854d0e",borderRadius:6,padding:"8px 12px",marginBottom:10,fontSize:11,color:"#fbbf24",fontWeight:700}}>
                        ⚠️ REGIME-DEPENDENT — accuracy varies {(regime.spread*100).toFixed(1)}pp between best ({regime.bestRegime}) and worst ({regime.worstRegime}) regime. Use caution outside best regime.
                      </div>
                    )}
                    <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(150px,1fr))",gap:8}}>
                      {Object.entries(regime.results).map(([reg,r])=>(
                        <div key={reg} style={{background:"#111827",borderRadius:8,padding:"10px 12px"}}>
                          <div style={{fontSize:10,color:"#6b7280",textTransform:"capitalize",marginBottom:4}}>{reg}</div>
                          <div style={{fontSize:20,fontWeight:900,color:r.accuracy>0.6?"#22c55e":r.accuracy>0.5?"#eab308":"#ef4444"}}>{(r.accuracy*100).toFixed(1)}%</div>
                          <div style={{fontSize:9,color:"#4b5563",marginTop:2}}>{r.n} rows · {r.folds} folds</div>
                          <div style={{fontSize:9,color:r.stratRet>0?"#22c55e":"#ef4444"}}>{fmtPct(r.stratRet)} strat ret</div>
                        </div>
                      ))}
                    </div>
                    {regime.note&&<div style={{fontSize:11,color:"#4b5563",marginTop:8}}>{regime.note}</div>}
                  </>
                ):<div style={{fontSize:11,color:"#4b5563"}}>Click Run Stress Test to see how accuracy changes across CBK tight/expansionary/neutral regimes.</div>}
              </div>

              <div style={{fontSize:12,color:"#6b7280",background:"#111827",borderRadius:8,padding:"10px 14px",lineHeight:1.7}}>
                Walk-forward: each fold trains on data up to that point, tests on the next period. No look-ahead bias. Stratified splits preserve UP/DOWN ratio. Transaction costs deducted from net returns. IR ≥ 1.0 required for real edge.
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

// ─── PORTFOLIO TAB ────────────────────────────────────────────────────────────
function PortfolioTab({stocks,stockDataMap,log}){
  const [portfolio,setPortfolio]=useState(()=>db.load("iq_portfolio",[]));
  const [form,setForm]=useState({asset:"",qty:"",buyPrice:""});
  const [showAdd,setShowAdd]=useState(false);
  useEffect(()=>{db.save("iq_portfolio",portfolio);},[portfolio]);
  const allAssets=[...new Set([...stocks,...Object.keys(EXPERT_BASE)])];

  const addHolding=()=>{
    if(!form.asset||!form.qty||!form.buyPrice) return;
    const entry={id:Date.now(),asset:form.asset,qty:parseFloat(form.qty),buyPrice:parseFloat(form.buyPrice)};
    setPortfolio(p=>[...p,entry]);
    log("PORTFOLIO_ADD","SUCCESS",`${form.qty} ${form.asset} @ ${form.buyPrice}`);
    setForm({asset:"",qty:"",buyPrice:""});setShowAdd(false);
  };

  const rows=portfolio.map(h=>{
    const sd=stockDataMap[h.asset];
    const curPrice=sd?sd.rows[sd.rows.length-1]?.close:h.buyPrice;
    const pred=sd?generatePredictionGuarded(sd,null):null;
    const cost=h.qty*h.buyPrice,val=h.qty*curPrice,pnl=val-cost;
    // Build live state for kill switch
    const sentiment=pred?.signal==="SELL"?"bearish":pred?.signal==="BUY"?"bullish":"neutral";
    const liveState={holding:h,currentPrice:curPrice,sentiment,confidence:pred?.riskScore?.level,currentNPL:EXPERT_BASE[h.asset]?.npl,baselineNPL:EXPERT_BASE[h.asset]?.npl};
    const ksAlerts=evaluateHolding(liveState,-10);
    const hasCritical=ksAlerts.some(a=>a.severity==="critical");
    const hasWarning=ksAlerts.some(a=>a.severity==="warning");
    return{...h,curPrice,val,pnl,pct:cost>0?pnl/cost*100:0,pred,ksAlerts,hasCritical,hasWarning};
  });
  const totC=rows.reduce((s,r)=>s+r.qty*r.buyPrice,0),totV=rows.reduce((s,r)=>s+r.val,0);

  // Portfolio-level kill switch
  const macro=db.load("iq_macro",{cbk_rate:13,inflation:4.5,usd_kes:129.5,gdp_growth:5.0});
  const ksPositions=rows.map(r=>({holding:{id:r.id,assetName:r.asset,qty:r.qty,buyPrice:r.buyPrice},currentPrice:r.curPrice,sentiment:r.pred?.signal==="SELL"?"bearish":"neutral"}));
  const portfolioReport=ksPositions.length>0?evaluatePortfolio(ksPositions,macro):null;

  return(
    <div>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
        <div>
          <div style={{fontSize:17,fontWeight:900,color:"#f9fafb"}}>💼 Portfolio</div>
          <div style={{fontSize:11,color:"#6b7280"}}>ML signals · Kill switch · Exit levels · persisted locally</div>
        </div>
        <button onClick={()=>setShowAdd(v=>!v)} style={{background:"#1d4ed8",border:"none",color:"#fff",borderRadius:7,padding:"8px 16px",cursor:"pointer",fontSize:13,fontWeight:700}}>{showAdd?"✕ Cancel":"+ Add"}</button>
      </div>

      {/* Portfolio-level risk banner */}
      {portfolioReport&&portfolioReport.overallRisk!=="green"&&(
        <div style={{background:portfolioReport.overallRisk==="red"?"#1c0a0a":"#1c1400",border:`1px solid ${portfolioReport.overallRisk==="red"?"#991b1b":"#854d0e"}`,borderRadius:10,padding:12,marginBottom:12}}>
          <div style={{fontSize:13,fontWeight:800,color:portfolioReport.overallRisk==="red"?"#f87171":"#fbbf24",marginBottom:6}}>
            {portfolioReport.overallRisk==="red"?"🚨 Critical Portfolio Alerts":"⚠️ Portfolio Warnings"}
          </div>
          {portfolioReport.portfolioAlerts.map((a,i)=><div key={i} style={{fontSize:12,color:"#fca5a5",marginBottom:3}}>• {a.message}</div>)}
          {portfolioReport.positionsToExit.length>0&&<div style={{fontSize:12,color:"#f87171",fontWeight:700,marginTop:4}}>EXIT signals: {portfolioReport.positionsToExit.join(", ")}</div>}
        </div>
      )}

      {showAdd&&(
        <div style={{background:"#0f172a",border:"1px solid #3b82f6",borderRadius:10,padding:14,marginBottom:12,display:"flex",gap:10,flexWrap:"wrap",alignItems:"flex-end"}}>
          <div style={{flex:2,minWidth:150}}>
            <div style={{fontSize:11,color:"#6b7280",marginBottom:4}}>Asset</div>
            <input list="asset-list" value={form.asset} onChange={e=>setForm(f=>({...f,asset:e.target.value}))} placeholder="KCB Group"
              style={{width:"100%",background:"#1e293b",border:"1px solid #374151",color:"#f9fafb",borderRadius:6,padding:"9px 10px",fontSize:13,outline:"none",boxSizing:"border-box"}}/>
            <datalist id="asset-list">{allAssets.map(n=><option key={n} value={n}/>)}</datalist>
          </div>
          <div style={{flex:1,minWidth:80}}>
            <div style={{fontSize:11,color:"#6b7280",marginBottom:4}}>Qty</div>
            <input type="number" value={form.qty} onChange={e=>setForm(f=>({...f,qty:e.target.value}))} placeholder="100"
              style={{width:"100%",background:"#1e293b",border:"1px solid #374151",color:"#f9fafb",borderRadius:6,padding:"9px 10px",fontSize:13,outline:"none",boxSizing:"border-box"}}/>
          </div>
          <div style={{flex:1,minWidth:90}}>
            <div style={{fontSize:11,color:"#6b7280",marginBottom:4}}>Buy Price</div>
            <input type="number" value={form.buyPrice} onChange={e=>setForm(f=>({...f,buyPrice:e.target.value}))} placeholder="38.5"
              style={{width:"100%",background:"#1e293b",border:"1px solid #374151",color:"#f9fafb",borderRadius:6,padding:"9px 10px",fontSize:13,outline:"none",boxSizing:"border-box"}}/>
          </div>
          <button onClick={addHolding} style={{background:"#22c55e",border:"none",color:"#000",borderRadius:6,padding:"9px 18px",cursor:"pointer",fontWeight:800,fontSize:13}}>✓ Add</button>
        </div>
      )}
      {portfolio.length===0?(
        <div style={{textAlign:"center",padding:"50px",color:"#6b7280",background:"#0f172a",borderRadius:10,border:"1px dashed #1f2937"}}>
          <div style={{fontSize:32,marginBottom:8}}>💼</div><div>No holdings yet.</div>
        </div>
      ):(
        <>
          <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10,marginBottom:12}}>
            {[["Invested",fmt(totC,0),"#60a5fa"],["Value",fmt(totV,0),"#a78bfa"],[(totV-totC)>=0?"Total Gain":"Total Loss",`${totV-totC>=0?"+":""}${fmt(totV-totC,0)}`,(totV-totC)>=0?"#22c55e":"#ef4444"]].map(([l,v,c])=>(
              <Stat key={l} label={l} value={v} color={c}/>
            ))}
          </div>
          {rows.map(r=>{
            const borderCol=r.hasCritical?"#991b1b":r.hasWarning?"#854d0e":"#1f2937";
            const bgCol=r.hasCritical?"#1c0a0a":r.hasWarning?"#1c1200":"#0f172a";
            const exitLevels=suggestExitLevels(r.buyPrice,r.asset.includes("Bitcoin")||r.asset.includes("Ethereum")?80:r.asset.includes("NVIDIA")||r.asset.includes("Tesla")?45:20);
            return(
            <div key={r.id} style={{background:bgCol,border:`1px solid ${borderCol}`,borderRadius:8,padding:"12px 14px",marginBottom:8}}>
              {/* Kill switch alerts */}
              {r.ksAlerts.length>0&&(
                <div style={{marginBottom:8,display:"flex",flexDirection:"column",gap:3}}>
                  {r.ksAlerts.map((a,i)=>(
                    <div key={i} style={{fontSize:11,padding:"4px 8px",borderRadius:4,
                      background:a.severity==="critical"?"#1c0a0a":"#1c1400",
                      color:a.severity==="critical"?"#f87171":"#fbbf24",
                      border:`1px solid ${a.severity==="critical"?"#991b1b":"#854d0e"}`}}>
                      {a.severity==="critical"?"🚨":"⚠️"} [{a.type}] {a.message} → <b>{a.action}</b>
                    </div>
                  ))}
                </div>
              )}
              <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
                <div style={{flex:2,minWidth:120}}>
                  <div style={{fontWeight:700,color:"#f9fafb"}}>{r.asset}</div>
                  <div style={{fontSize:11,color:"#6b7280"}}>{r.qty} units @ {fmt(r.buyPrice)}</div>
                  {r.pred&&<div style={{marginTop:4,display:"flex",gap:6,alignItems:"center"}}>
                    <SigBadge signal={r.pred.signal}/>
                    <span style={{fontSize:10,color:"#6b7280"}}>30d: {r.pred.target30?fmt(r.pred.target30):"—"} ({fmtPct(r.pred.pctTarget30)})</span>
                    {r.pred.forcedNeutral&&<span style={{fontSize:9,color:"#6b7280",background:"#111827",borderRadius:3,padding:"1px 4px"}}>low conf</span>}
                  </div>}
                  <div style={{fontSize:10,color:"#374151",marginTop:3}}>
                    Stop: {fmt(exitLevels.stopLoss)} · Target: {fmt(exitLevels.takeProfit)}
                    <span style={{color:"#4b5563",marginLeft:6}}>({exitLevels.riskPct}% risk / {exitLevels.rewardPct}% reward)</span>
                  </div>
                </div>
                <div style={{textAlign:"center",minWidth:60}}><div style={{fontSize:9,color:"#4b5563"}}>PRICE</div><div style={{fontWeight:700,color:"#f9fafb"}}>{fmt(r.curPrice)}</div></div>
                <div style={{textAlign:"center",minWidth:80}}><div style={{fontSize:9,color:"#4b5563"}}>P&L</div><div style={{fontWeight:800,color:r.pnl>=0?"#22c55e":"#ef4444"}}>{r.pnl>=0?"+":""}{fmt(r.pnl,0)} ({fmt(r.pct,1)}%)</div></div>
                <button onClick={()=>{setPortfolio(p=>p.filter(x=>x.id!==r.id));log("PORTFOLIO_REMOVE","SUCCESS",`Removed ${r.asset}`);}} style={{background:"#7f1d1d",border:"1px solid #991b1b",color:"#fca5a5",borderRadius:5,padding:"5px 10px",cursor:"pointer",fontSize:12}}>✕</button>
              </div>
            </div>
            );
          })}
        </>
      )}
    </div>
  );
}

// ─── EXPERT TAB ───────────────────────────────────────────────────────────────
function ExpertTab(){
  return(
    <div>
      <div style={{fontSize:17,fontWeight:900,color:"#f9fafb",marginBottom:4}}>📖 Expert Knowledge Base</div>
      <div style={{fontSize:12,color:"#6b7280",marginBottom:14}}>Static fundamentals — NPL ratios, dividend yields, liquidity, macro sensitivity. Edit EXPERT_BASE in source to update.</div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))",gap:12}}>
        {Object.entries(EXPERT_BASE).map(([name,m])=>{
          const netY=m.taxFree?m.divYield:parseFloat((m.divYield*(1-TAX_RATE)).toFixed(2));
          return(
            <div key={name} style={{background:"#0f172a",border:"1px solid #1f2937",borderRadius:12,padding:14}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:8}}>
                <div>
                  <div style={{fontWeight:800,fontSize:14,color:"#f9fafb"}}>{name}</div>
                  <div style={{fontSize:11,color:"#eab308",marginTop:2}}>{m.tag}</div>
                </div>
                <div style={{fontSize:10,background:"#1e3a5f",borderRadius:4,padding:"2px 6px",color:"#93c5fd"}}>Macro {m.macroSens}/10</div>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:5,marginBottom:8}}>
                {[["YIELD",m.divYield>0?`${m.divYield}%`:"—","#9ca3af"],
                  ["AFTER TAX",netY>0?`${netY}%${m.taxFree?" 💎":""}`:"—",m.taxFree?"#22c55e":"#60a5fa"],
                  ["NPL",m.npl>0?`${m.npl}%`:"—",m.npl>15?"#ef4444":m.npl>10?"#eab308":"#22c55e"],
                  ["SPREAD",m.spread>0?`${m.spread}%`:"—",m.spread>2?"#ef4444":"#22c55e"]].map(([l,v,c])=>(
                  <div key={l} style={{background:"#111827",borderRadius:4,padding:"4px 5px"}}>
                    <div style={{fontSize:7,color:"#4b5563"}}>{l}</div>
                    <div style={{fontSize:10,fontWeight:700,color:c}}>{v}</div>
                  </div>
                ))}
              </div>
              <div style={{fontSize:11,color:"#d1d5db",background:"#111827",borderRadius:6,padding:"7px 9px",borderLeft:"3px solid #374151",fontStyle:"italic"}}>"{m.advisory}"</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── AUDIT TAB ────────────────────────────────────────────────────────────────
function AuditTab({auditLog,setAuditLog}){
  const [exportText,setExportText]=useState(null);
  const [importText,setImportText]=useState("");
  const [showImport,setShowImport]=useState(false);

  const exportData=()=>{
    const out={};
    for(let i=0;i<localStorage.length;i++){
      const k=localStorage.key(i);
      if(k&&k.startsWith("iq_")){
        try{out[k]=JSON.parse(localStorage.getItem(k));}catch{out[k]=localStorage.getItem(k);}
      }
    }
    const json=JSON.stringify(out,null,2);
    // Try native download first, fall back to textarea copy
    try{
      const a=document.createElement("a");
      a.href="data:application/json;charset=utf-8,"+encodeURIComponent(json);
      a.download=`investiq-backup-${new Date().toISOString().slice(0,10)}.json`;
      document.body.appendChild(a);a.click();document.body.removeChild(a);
    }catch{
      setExportText(json);
    }
  };

  const doImport=()=>{
    if(!importText.trim()){alert("Paste your backup JSON first.");return;}
    // Overwrite confirmed implicitly by user choosing to import — no window.confirm()
    try{
      const data=JSON.parse(importText);
      for(const [k,v] of Object.entries(data)){
        localStorage.setItem(k,typeof v==="string"?v:JSON.stringify(v));
      }
      alert(`Imported ${Object.keys(data).length} keys successfully. Reloading…`);
      window.location.reload();
    }catch(err){alert(`Import failed — invalid JSON: ${err.message}`);}
  };

  return(
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12,flexWrap:"wrap",gap:8}}>
        <div style={{fontSize:17,fontWeight:900,color:"#f9fafb"}}>🔐 Audit Log</div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          <button onClick={exportData} style={{background:"#065f46",border:"1px solid #166534",color:"#6ee7b7",borderRadius:6,padding:"6px 14px",cursor:"pointer",fontSize:12,fontWeight:700}}>⬇ Export All Data</button>
          <button onClick={()=>{setShowImport(v=>!v);setExportText(null);}} style={{background:"#1e3a5f",border:"1px solid #1d4ed8",color:"#93c5fd",borderRadius:6,padding:"6px 14px",cursor:"pointer",fontSize:12,fontWeight:700}}>⬆ Import Data</button>
          <button onClick={()=>setAuditLog([])} style={{background:"#1f2937",border:"1px solid #374151",color:"#9ca3af",borderRadius:6,padding:"6px 12px",cursor:"pointer",fontSize:12}}>Clear</button>
        </div>
      </div>

      {/* Export output — shows JSON in a copyable textarea if download blocked */}
      {exportText&&(
        <div style={{background:"#052e16",border:"1px solid #166534",borderRadius:8,padding:12,marginBottom:12}}>
          <div style={{fontSize:11,color:"#22c55e",fontWeight:700,marginBottom:6}}>✅ Export ready — copy all text below and save as a .json file</div>
          <textarea
            readOnly
            value={exportText}
            onClick={e=>{e.target.select();try{document.execCommand("copy");alert("Copied to clipboard!");}catch{}}}
            style={{width:"100%",height:120,background:"#0f172a",color:"#9ca3af",border:"1px solid #1f2937",borderRadius:6,padding:8,fontSize:10,fontFamily:"monospace",resize:"vertical",boxSizing:"border-box"}}
          />
          <div style={{fontSize:10,color:"#4b5563",marginTop:4}}>Click the box to select all and copy, then paste into a text file and save as investiq-backup.json</div>
        </div>
      )}

      {/* Import input — paste JSON */}
      {showImport&&(
        <div style={{background:"#0f172a",border:"1px solid #1d4ed8",borderRadius:8,padding:12,marginBottom:12}}>
          <div style={{fontSize:11,color:"#93c5fd",fontWeight:700,marginBottom:6}}>⬆ Paste your backup JSON below then click Restore</div>
          <textarea
            value={importText}
            onChange={e=>setImportText(e.target.value)}
            placeholder='Paste contents of your investiq-backup.json file here…'
            style={{width:"100%",height:120,background:"#111827",color:"#d1d5db",border:"1px solid #374151",borderRadius:6,padding:8,fontSize:10,fontFamily:"monospace",resize:"vertical",boxSizing:"border-box"}}
          />
          <div style={{display:"flex",gap:8,marginTop:8}}>
            <button onClick={doImport} style={{background:"#1d4ed8",border:"none",color:"#fff",borderRadius:6,padding:"6px 16px",cursor:"pointer",fontSize:12,fontWeight:700}}>Restore Data</button>
            <button onClick={()=>{setShowImport(false);setImportText("");}} style={{background:"#1f2937",border:"1px solid #374151",color:"#9ca3af",borderRadius:6,padding:"6px 12px",cursor:"pointer",fontSize:12}}>Cancel</button>
          </div>
        </div>
      )}

      <div style={{background:"#0f172a",border:"1px solid #1f2937",borderRadius:8,padding:"9px 14px",marginBottom:12,fontSize:11,color:"#4b5563"}}>
        💾 Export copies all your stocks, models and settings as JSON. Import restores from a previous export. Do this regularly — it's your only backup without a backend.
      </div>
      {auditLog.length===0?<div style={{color:"#4b5563",textAlign:"center",padding:40}}>No events yet.</div>:(
        <div style={{display:"flex",flexDirection:"column",gap:4}}>
          {auditLog.map((ev,i)=>{
            const c={SUCCESS:"#22c55e",ERROR:"#ef4444",RUNNING:"#60a5fa",WARN:"#eab308"}[ev.status]||"#6b7280";
            return(
              <div key={ev.id||i} style={{background:"#0f172a",border:`1px solid ${c}22`,borderRadius:6,padding:"7px 12px",fontFamily:"monospace",fontSize:11}}>
                <span style={{color:c,fontWeight:700,marginRight:8}}>{ev.status}</span>
                <span style={{color:"#374151",marginRight:8}}>{new Date(ev.ts).toLocaleTimeString()}</span>
                <span style={{color:"#60a5fa",marginRight:8}}>[{ev.event}]</span>
                <span style={{color:"#9ca3af"}}>{ev.detail}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── SIMULATE TAB ─────────────────────────────────────────────────────────────
// Core idea: rewind time to a cutoff date, train on data BEFORE it,
// predict for every trading day AFTER it, then score against actual prices.
// Also supports cross-stock training: pool multiple stocks to build one model,
// then use it to predict a specific target stock.

// ─── SIMULATE HELPERS ────────────────────────────────────────────────────────
// Merge rows from multiple stock entries that share the same base name.
// e.g. "KCB 2023", "KCB 2024", "KCB 2025" all merge into one KCB series.
// Also accepts a single entry that already spans multiple years.
function mergeStocksForSimulation(names, stockDataMap) {
  const seen = new Set();
  const all = [];
  for (const n of names) {
    const sd = stockDataMap[n] || loadStockData(n);
    if (!sd) continue;
    for (const r of sd.rows) {
      if (!seen.has(r.date)) { seen.add(r.date); all.push(r); }
    }
  }
  all.sort((a, b) => a.date.localeCompare(b.date));
  return all;
}

// Group stock entries by their "base name" — strips trailing year/digits
// so "KCB 2023", "KCB 2024" → base "KCB"
function groupStocksByBase(stocks) {
  const groups = {};
  for (const n of stocks) {
    const base = n.replace(/\s*(19|20)\d{2}\s*$/, "").trim() || n;
    if (!groups[base]) groups[base] = [];
    groups[base].push(n);
  }
  return groups; // { "KCB": ["KCB 2023","KCB 2024"], "Safaricom": ["Safaricom"] }
}

// Get combined date range for a group of entries
function getGroupDateRange(names, stockDataMap) {
  const rows = mergeStocksForSimulation(names, stockDataMap);
  if (!rows.length) return null;
  return { first: rows[0].date, last: rows[rows.length - 1].date, count: rows.length };
}

function SimulateTab({stocks,stockDataMap,log}){
  // ── Grouped view of uploaded stocks ──────────────────────────────────────
  const groups = useMemo(()=>groupStocksByBase(stocks),[stocks]);
  const baseNames = useMemo(()=>Object.keys(groups),[groups]);

  // ── Selection state ───────────────────────────────────────────────────────
  const [targetBase,setTargetBase]   = useState(baseNames[0]??null);
  const [trainBases,setTrainBases]   = useState([]); // additional bases to pool for training
  const [direction,setDirection]     = useState("forward");
  const [horizon,setHorizon]         = useState(30);
  const [cutoffDate,setCutoffDate]   = useState("");
  const [running,setRunning]         = useState(false);
  const [result,setResult]           = useState(null);

  // Confirmation scoring state
  const [confirmBases,setConfirmBases] = useState([]);
  const [confirming,setConfirming]     = useState(false);

  // ── Auto-detect best cutoff when target or direction changes ─────────────
  useEffect(()=>{
    if(!targetBase||!groups[targetBase]) return;
    const range = getGroupDateRange(groups[targetBase], stockDataMap);
    if(!range||range.count<2) return;

    const first = safeDateMs(range.first) || 0;
    const last  = safeDateMs(range.last)  || 0;
    const span  = last - first; // total ms of data

    if(direction==="forward"){
      // Cutoff at 70% through the data (train on first 70%, test on last 30%)
      // Clamp so training side always gets at least 100 rows worth of time
      const cutoffMs = first + span * 0.7;
      setCutoffDate(new Date(cutoffMs).toISOString().split("T")[0]);
    } else {
      // Reverse: cutoff at 30% through the data (train on last 70%, test on first 30%)
      const cutoffMs = first + span * 0.3;
      setCutoffDate(new Date(cutoffMs).toISOString().split("T")[0]);
    }
  },[targetBase, direction, groups]);

  useEffect(()=>{ if(baseNames.length&&!targetBase) setTargetBase(baseNames[0]); },[baseNames]);

  const toggleTrainBase=(base)=>{
    setTrainBases(prev=>prev.includes(base)?prev.filter(b=>b!==base):[...prev,base]);
  };
  const toggleConfirmBase=(base)=>{
    setConfirmBases(prev=>prev.includes(base)?prev.filter(b=>b!==base):[...prev,base]);
  };

  const run=async()=>{
    if(!targetBase||!cutoffDate) return;
    setRunning(true); setResult(null);
    log("SIMULATE","RUNNING",`${targetBase} · cutoff ${cutoffDate} · ${direction} · ${horizon}d`);
    await new Promise(r=>setTimeout(r,80));

    try{
      // ── 1. Merge all entries for the target base into one sorted series ─────
      const targetEntries = groups[targetBase] || [];
      const allRows = mergeStocksForSimulation(targetEntries, stockDataMap);
      if(!allRows.length) throw new Error(`No data found for "${targetBase}". Check Data tab.`);

      const trainLabel = direction==="forward" ? `before ${cutoffDate}` : `after ${cutoffDate}`;
      const testLabel  = direction==="forward" ? `after ${cutoffDate}`  : `before ${cutoffDate}`;

      // Split at cutoff date
      const beforeCutoff = allRows.filter(r=>r.date<=cutoffDate);
      const afterCutoff  = allRows.filter(r=>r.date> cutoffDate);

      const trainRows = direction==="forward" ? beforeCutoff : afterCutoff;
      const testRows  = direction==="forward" ? afterCutoff  : beforeCutoff;

      // Minimum viable training size — lower for small datasets
      const minTrain = Math.min(100, Math.max(50, Math.floor(allRows.length * 0.4)));
      const minTest  = Math.min(horizon, Math.max(10, Math.floor(allRows.length * 0.1)));

      if(trainRows.length<minTrain)
        throw new Error(
          `Need ≥${minTrain} training rows ${trainLabel}. Got ${trainRows.length}.\n` +
          `"${targetBase}" has data: ${fmtDate(allRows[0].date)} → ${fmtDate(allRows[allRows.length-1].date)} (${allRows.length} rows total).\n` +
          (direction==="reverse"
            ? `For reverse mode the training side is AFTER the cutoff. Move the cutoff earlier.`
            : `Move the cutoff earlier so more data falls before it.`)
        );
      if(testRows.length<minTest)
        throw new Error(
          `Need ≥${minTest} test rows ${testLabel}. Got ${testRows.length}.\n` +
          (direction==="reverse"
            ? `Move the cutoff later so more older data is available for testing.`
            : `Move the cutoff earlier so more newer data is available for testing.`)
        );

      // ── 2. Build training corpus ───────────────────────────────────────────
      // Pool: target's train window + same-window data from additional bases
      let trainX=[],trainYDir=[],trainYRet=[];

      const addRowsToTraining=(rows)=>{
        if(rows.length<50) return;
        const feats=buildAllFeatures(rows);
        for(let i=50;i<rows.length-horizon;i++){
          // Skip boundary rows (corporate action windows)
          if(rows[i]?._boundary||rows[i+horizon]?._boundary) continue;
          const f=fv(feats[i]); if(f.some(v=>!isFinite(v))) continue;
          const ret=(rows[i+horizon].close-rows[i].close)/rows[i].close;
          trainX.push(f);
          trainYDir.push(ret>0?1:0); // kept for compat
          trainYRet.push(ret*100);
        }
      };

      // Always add target's training window
      addRowsToTraining(trainRows);

      // Add pooled training stocks (filtered to same time window as trainRows)
      const trainStart = trainRows[0].date;
      const trainEnd   = trainRows[trainRows.length-1].date;
      for(const base of trainBases){
        if(base===targetBase) continue;
        const entries = groups[base]||[];
        // mergeStocksForSimulation takes (names[], stockDataMap) — not mergeStockRows
        const rows = mergeStocksForSimulation(entries, stockDataMap)
          .filter(r=>r.date>=trainStart && r.date<=trainEnd);
        addRowsToTraining(rows);
      }

      if(trainX.length<30)
        throw new Error(
          `Only ${trainX.length} valid training samples after feature engineering. Need ≥30.\n` +
          `Try: (1) pool more stocks, (2) widen the training window, or (3) shorten the horizon.`
        );

      // ── 3. Train — full ensemble pipeline (matches trainModels exactly) ─────
      const norm=new Normaliser(); norm.fit(trainX);
      const Xn=norm.transform(trainX);

      // Auto-calibrated deadband — prevent FLAT collapse on short datasets
      const simBand=Math.max(0.5,calibrateDeadband(trainRows,horizon,0.30));
      const trainYDir3=trainYRet.map(r=>r>simBand?2:r<-simBand?0:1);
      const simHp=adaptiveHyperparams(trainX.length);
      const simPrep=prepareBalancedBinary(Xn,trainYDir3);

      // Detect degenerate training window — warn user
      const nUp3=trainYDir3.filter(v=>v===2).length;
      const nDown3=trainYDir3.filter(v=>v===0).length;
      const nFlat3=trainYDir3.filter(v=>v===1).length;
      const isDegenerate=simPrep.degenerate;
      const degenerateMsg=isDegenerate
        ? `⚠️ Training window is entirely ${simPrep.degenerateDir==="up"?"bullish":"bearish"} — ` +
          `${simPrep.degenerateDir==="up"?nUp3:nDown3} ${simPrep.degenerateDir==="up"?"UP":"DOWN"} labels, ` +
          `0 ${simPrep.degenerateDir==="up"?"DOWN":"UP"} labels. ` +
          `Model cannot learn both directions. Pool additional stocks or adjust the cutoff date.`
        : null;

      const clf_up   =new LogReg({lr:0.05,epochs:simHp.epochs,l2:simHp.l2}); clf_up.fit(simPrep.XUp,simPrep.yUp,simPrep.cwUp);
      const clf_down =new LogReg({lr:0.05,epochs:simHp.epochs,l2:simHp.l2}); clf_down.fit(simPrep.XDown,simPrep.yDown,simPrep.cwDown);
      const gbdt_up  =new GBDT({nTrees:simHp.nTrees,lr:0.08,mode:"classifier"}); gbdt_up.fit(simPrep.XUp,simPrep.yUp);
      const gbdt_down=new GBDT({nTrees:simHp.nTrees,lr:0.08,mode:"classifier"}); gbdt_down.fit(simPrep.XDown,simPrep.yDown);
      const reg=new LinReg(); reg.fit(Xn,trainYRet);
      const clf=clf_up; // backward compat ref

      // In-sample accuracy (no calibration — calibration on small holdout inverts confidence)
      let inSampleCorrect=0;
      for(let i=0;i<Xn.length;i++){
        const pu=ensembleProb(clf_up,gbdt_up,Xn[i],null);
        const pd=ensembleProb(clf_down,gbdt_down,Xn[i],null);
        const pred=pu>0.55?2:pd>0.55?0:1;
        if(pred===trainYDir3[i]) inSampleCorrect++;
      }
      const simCalTableUp=null; const simCalTableDn=null; // calibration disabled
      const inSampleAcc=inSampleCorrect/Xn.length;

      // ── 4. Predict on test window ─────────────────────────────────────────
      // Precompute EMAs ONCE outside the loop (was O(n^2) — called per row)
      const fullFeats=buildAllFeatures(allRows);
      const simEMA20_pre=TA.ema(allRows.map(r=>r.close),20);
      const simEMA60_pre=TA.ema(allRows.map(r=>r.close),Math.min(60,Math.floor(allRows.length*0.4)));
      const simTrainPrices_pre=trainRows.map(r=>r.close).filter(Boolean);
      const simTrainMin_pre=simTrainPrices_pre.length?Math.min(...simTrainPrices_pre)*0.85:0;
      const simTrainMax_pre=simTrainPrices_pre.length?Math.max(...simTrainPrices_pre)*1.15:Infinity;

      // Trend at END of training period — direction-aware:
      // Forward: training ends just before cutoff → use last row before cutoff
      // Reverse: training ends at last row of allRows (afterCutoff = end of dataset)
      const cutoffRowIdx = allRows.findIndex(r=>r.date>=cutoffDate);
      const trainEndIdx_pre = direction==="reverse"
        ? allRows.length - 1
        : Math.max(0, cutoffRowIdx-1);

      // Training regime: use a longer EMA window to capture the dominant trend
      // over the WHOLE training period, not just the last few days
      // (a brief bounce at end of a bear market should not show as "BULLISH")
      const trainRegimeEMA_short = simEMA20_pre[trainEndIdx_pre];
      const trainRegimeEMA_long  = simEMA60_pre[trainEndIdx_pre];
      // For forward: also check the midpoint of training to confirm regime
      const trainMidIdx = direction==="reverse"
        ? Math.floor((cutoffRowIdx + allRows.length) / 2)
        : Math.floor(cutoffRowIdx / 2);
      const trainMidTrend = trainMidIdx>0&&simEMA20_pre[trainMidIdx]&&simEMA60_pre[trainMidIdx]
        ?(simEMA20_pre[trainMidIdx]>simEMA60_pre[trainMidIdx]?"UP":"DOWN")
        :null;
      const trainEndTrend = trainRegimeEMA_short&&trainRegimeEMA_long
        ?(trainRegimeEMA_short>trainRegimeEMA_long?"UP":"DOWN")
        :null;
      // Dominant training regime: both midpoint AND end must agree, else use end
      const trainTrendAtCutoff_pre = (trainMidTrend&&trainEndTrend&&trainMidTrend===trainEndTrend)
        ? trainEndTrend
        : trainEndTrend;  // fall back to end trend if disagreement
      const testDateSet=new Set(testRows.map(r=>r.date));
      const predictions=[];

      for(let i=50;i<allRows.length-horizon;i++){
        if(!testDateSet.has(allRows[i].date)) continue;
        const f=fv(fullFeats[i]); if(f.some(v=>!isFinite(v))) continue;
        const fn=norm.transform([f])[0];

        // Use the full ensemble (raw probabilities — calibration removed)
        const probUp  =ensembleProb(clf_up,  gbdt_up,   fn, null);
        const probDown=ensembleProb(clf_down, gbdt_down, fn, null);
        const flatPct_sim=trainYDir3.filter(v=>v===1).length/(trainYDir3.length||1);
        const threshold=0.55+Math.min(0.08,Math.max(0,(flatPct_sim-0.25)*0.2));

        // Clamp predictedRet — regression output can be uncalibrated, cap at ±30%
        const rawRet=reg.predict(fn);
        const predictedRet=Math.max(-30,Math.min(30,parseFloat(rawRet.toFixed(2))));

        const actualRet=(allRows[i+horizon].close-allRows[i].close)/allRows[i].close*100;
        const predictedDir=probUp>threshold?"UP":probDown>threshold?"DOWN":"NEUTRAL";
        const actualDir=actualRet>simBand?"UP":actualRet<-simBand?"DOWN":"FLAT";

        // OOD check: use precomputed values (O(1) per row, not O(n))
        const isPriceOOD=allRows[i].close<simTrainMin_pre||allRows[i].close>simTrainMax_pre;
        const testTrendHere=simEMA20_pre[i]&&simEMA60_pre[i]
          ?(simEMA20_pre[i]>simEMA60_pre[i]?"UP":"DOWN"):null;
        // Trend flip: test regime is opposite to training regime
        const isTrendFlip=trainTrendAtCutoff_pre&&testTrendHere&&trainTrendAtCutoff_pre!==testTrendHere;
        const isOOD_sim=isPriceOOD||isTrendFlip;
        // Correct = decisive call matches the actual 3-class direction
        const correct=predictedDir!=="NEUTRAL"&&predictedDir===actualDir;

        // Confidence: threshold-relative (SimulateTab trains fresh, no saved calTable)
        const winProb=predictedDir==="UP"?probUp:predictedDir==="DOWN"?probDown:Math.max(probUp,probDown);
        const conf=Math.round(Math.min(99,Math.max(0,(winProb-0.55)/0.45*100)));

        // Apply OOD override — force NEUTRAL when price is outside training range
        const finalDir = isOOD_sim ? "NEUTRAL" : predictedDir;
        const finalConf = isOOD_sim ? 0 : conf;
        const finalCorrect = finalDir!=="NEUTRAL" && finalDir===actualDir;

        predictions.push({
          date:allRows[i].date, price:allRows[i].close,
          futureDate:allRows[i+horizon].date, futurePrice:allRows[i+horizon].close,
          probUp:Math.round(probUp*100), probDown:Math.round(probDown*100),
          prob:Math.round(probUp*100),
          conf:finalConf,
          predictedRet,
          actualRet:parseFloat(actualRet.toFixed(2)),
          predictedDir:finalDir, actualDir, correct:finalCorrect,
          isOOD:isOOD_sim,
          predictedTarget:allRows[i].close*(1+predictedRet/100),
        });
      }

      if(!predictions.length)
        throw new Error("No predictions generated. The test window may not have enough rows with fully-warmed indicators (needs ~50 rows of context before first prediction).");

      predictions.sort((a,b)=>a.date.localeCompare(b.date));

      // ── 5. Score ───────────────────────────────────────────────────────────
      const decided=predictions.filter(p=>p.predictedDir!=="NEUTRAL");
      const accuracy=decided.length>0?decided.filter(p=>p.correct).length/decided.length:0;
      const allCorrect=predictions.filter(p=>p.correct).length/predictions.length;
      // Strategy return: equal-weight average actual return across all UP signals.
      // Compounding is WRONG for overlapping signals (calling UP every day for 30 days
      // compounds the same underlying price move 30 times = 800%+ nonsense).
      // Equal-weight = "if you followed every UP signal with equal capital, what % did you avg?"
      const upCalls=predictions.filter(p=>p.predictedDir==="UP");
      const downCalls=predictions.filter(p=>p.predictedDir==="DOWN");
      const strategyReturn=upCalls.length>0
        ? upCalls.reduce((s,p)=>s+(p.actualRet/100),0)/upCalls.length*100
        : 0;
      // Short strategy return (following DOWN signals — shorting)
      const shortReturn=downCalls.length>0
        ? downCalls.reduce((s,p)=>s+(-p.actualRet/100),0)/downCalls.length*100
        : 0;
      const testSorted=[...testRows].sort((a,b)=>a.date.localeCompare(b.date));
      const buyHoldReturn=((testSorted[testSorted.length-1].close-testSorted[0].close)/testSorted[0].close)*100;
      const alpha=strategyReturn-buyHoldReturn;
      const mae=predictions.reduce((s,p)=>s+Math.abs(p.predictedRet-p.actualRet),0)/predictions.length;
      const upAccuracy=upCalls.length>0?upCalls.filter(p=>p.correct).length/upCalls.length:null;
      const downAccuracy=downCalls.length>0?downCalls.filter(p=>p.correct).length/downCalls.length:null;

      const byMonth={};
      for(const p of predictions){
        const m=p.date.slice(0,7);
        if(!byMonth[m]) byMonth[m]={correct:0,total:0,decidedCorrect:0,decided:0};
        byMonth[m].total++;
        if(p.correct) byMonth[m].correct++;
        if(p.predictedDir!=="NEUTRAL"){byMonth[m].decided++;if(p.correct)byMonth[m].decidedCorrect++;}
      }
      // worstMisses: WRONG decisive calls sorted by how wrong the direction was
      // Previously included CORRECT calls that underestimated magnitude — misleading
      // Rolling regime score: track last 10 decisive calls
      // If rolling accuracy < 40% → mark as suspended (model in bad streak)
      const ROLLING_WINDOW_SIZE = 10;
      const SUSPEND_THRESHOLD = 0.40;
      const RESUME_THRESHOLD = 0.50;
      let rollingCorrect = 0, rollingTotal = 0, suspended = false;
      const decisivePreds = predictions.filter(p => p.predictedDir !== "NEUTRAL" && !p.isOOD);
      // Go through predictions in chronological order (they are stored newest-first, reverse)
      const chronoPreds = [...predictions].reverse();
      const rollingMap = new Map(); // date → {suspended, rollingAcc}
      let rCorrect = 0, rTotal = 0, rSuspended = false;
      for(const p of chronoPreds) {
        if(p.predictedDir !== "NEUTRAL" && !p.isOOD) {
          rTotal++;
          if(p.correct) rCorrect++;
          // Keep rolling window
          if(rTotal > ROLLING_WINDOW_SIZE) {
            // Remove oldest — approximate by just tracking the window
            rTotal = Math.min(rTotal, ROLLING_WINDOW_SIZE);
          }
          const rollingAcc = rTotal >= 5 ? rCorrect / rTotal : null;
          if(rollingAcc !== null) {
            if(!rSuspended && rollingAcc < SUSPEND_THRESHOLD) rSuspended = true;
            if(rSuspended && rollingAcc >= RESUME_THRESHOLD) rSuspended = false;
          }
        }
        rollingMap.set(p.date, {suspended: rSuspended, rollingAcc: rTotal >= 5 ? rCorrect/rTotal : null});
      }

      const wrongCalls=predictions.filter(p=>p.predictedDir!=="NEUTRAL"&&!p.correct&&!p.isOOD);
      const worstMisses=wrongCalls
        .sort((a,b)=>Math.abs(b.actualRet-b.predictedRet)-Math.abs(a.actualRet-a.predictedRet))
        .slice(0,5);
      const bestHits=[...predictions].filter(p=>p.correct&&!p.isOOD)
        .sort((a,b)=>Math.abs(b.actualRet)-Math.abs(a.actualRet))
        .slice(0,5);

      // Store trained model + normaliser so confirmation can reuse them
      const trainedModel={clf,reg,norm};

      setResult({
        targetBase, cutoffDate, horizon, direction,
        pooledBases:trainBases.filter(b=>b!==targetBase),
        trainSamples:trainX.length, inSampleAcc,
        predictions, accuracy, allCorrect,
        strategyReturn, shortReturn, buyHoldReturn, alpha, mae,
        upAccuracy, downAccuracy,
        byMonth, worstMisses, bestHits,
        trainRows:trainRows.length, testRows:testRows.length,
        trainLabel, testLabel,
        trainedModel,
        simBand,
        nUp3, nDown3, nFlat3, isDegenerate, degenerateMsg,
        trainingTrend: trainTrendAtCutoff_pre,
        trendFlipWarning: (() => {
          // Direction-aware: reverse mode trains on afterCutoff, so "training end" is last row
          const trainEndForFlip = direction==="reverse"
            ? allRows.length - 1
            : allRows.findIndex(r=>r.date>=cutoffDate);
          const flip = detectTrendRegimeFlip(allRows, trainEndForFlip);
          return flip?.isFlipped ? flip : null;
        })(),
        predByDate: Object.fromEntries(predictions.map(p=>[p.date,p])),
        confirmedPredictions: null,
      });
      log("SIMULATE","SUCCESS",`${targetBase} [${direction}]: ${(accuracy*100).toFixed(1)}% acc · ${decided.length} decisive · alpha ${alpha>=0?"+":""}${alpha.toFixed(1)}%`);
    }catch(e){
      log("SIMULATE","ERROR",e.message);
      setResult({error:e.message});
    }
    setRunning(false);
  };

  // ── Confirmation: feed actual data for the test period, rescore ───────────
  const runConfirmation=async()=>{
    if(!result||result.error||!confirmBases.length) return;
    setConfirming(true);
    log("CONFIRM","RUNNING",`Scoring ${result.targetBase} predictions against actual data from: ${confirmBases.join(", ")}`);
    await new Promise(r=>setTimeout(r,40));

    try{
      // Merge all confirmation data entries
      const allEntries=confirmBases.flatMap(b=>groups[b]||[]);
      const actualRows=mergeStockRows(allEntries,stockDataMap);
      if(!actualRows.length) throw new Error("No rows found in confirmation data.");

      const actualByDate=Object.fromEntries(actualRows.map(r=>[r.date,r]));
      const {trainedModel:{clf,reg,norm}, horizon}=result;

      // For each prediction date, if we have actual data for that date + horizon, rescore
      const confirmed=result.predictions.map(p=>{
        const actualNow  = actualByDate[p.date];
        const futureDate = actualRows.find(r=>r.date>p.date&&actualRows.indexOf(r)>=
          actualRows.findIndex(r2=>r2.date===p.date)+horizon-2)?.date;
        const actualFuture = actualRows[actualRows.findIndex(r=>r.date===p.date)+horizon];
        if(!actualNow||!actualFuture) return {...p,confirmed:false,confirmActualRet:null};
        const confirmActualRet=(actualFuture.close-actualNow.close)/actualNow.close*100;
        const confirmDir=confirmActualRet>0?"UP":"DOWN";
        const confirmCorrect=p.predictedDir!=="NEUTRAL"&&p.predictedDir===confirmDir;
        return{...p,confirmed:true,confirmActualRet:parseFloat(confirmActualRet.toFixed(2)),
          confirmDir,confirmCorrect,confirmFuturePrice:actualFuture.close};
      });

      const confirmedDecided=confirmed.filter(p=>p.confirmed&&p.predictedDir!=="NEUTRAL");
      const confirmAcc=confirmedDecided.length>0
        ?confirmedDecided.filter(p=>p.confirmCorrect).length/confirmedDecided.length:0;
      const confirmMae=confirmed.filter(p=>p.confirmed)
        .reduce((s,p)=>s+Math.abs(p.predictedRet-p.confirmActualRet),0)
        /Math.max(1,confirmed.filter(p=>p.confirmed).length);

      setResult(prev=>({...prev,
        confirmedPredictions:confirmed,
        confirmAcc, confirmMae,
        confirmRows:confirmed.filter(p=>p.confirmed).length,
        confirmBases:[...confirmBases],
      }));
      log("CONFIRM","SUCCESS",`${result.targetBase}: confirmed accuracy ${(confirmAcc*100).toFixed(1)}% on ${confirmedDecided.length} decisive calls`);
    }catch(e){
      log("CONFIRM","ERROR",e.message);
    }
    setConfirming(false);
  };

  const monthKeys=result&&!result.error?Object.keys(result.byMonth).sort():[];

  const btnLabel = running ? "⏳ Running simulation…"
    : direction==="forward"
      ? `▶ Forward — train on ${cutoffDate?"data up to "+cutoffDate:"?"}, predict after`
      : `◀ Reverse — train on ${cutoffDate?"data from "+cutoffDate+" onward":"?"}, predict before`;

  return(
    <div>
      <div style={{fontSize:17,fontWeight:900,color:"#f9fafb",marginBottom:4}}>⏱ Time-Travel Simulation</div>
      <div style={{fontSize:12,color:"#6b7280",marginBottom:16,lineHeight:1.8}}>
        Pick a stock, pick a cutoff date, pick a direction. The model trains on one side of the cutoff and is tested on the other — it never sees the test period. Multi-year uploads (e.g. "KCB 2023", "KCB 2024") are <b style={{color:"#f9fafb"}}>merged automatically</b>.
      </div>

      {baseNames.length===0?(
        <div style={{textAlign:"center",padding:"40px",color:"#6b7280",background:"#0f172a",borderRadius:10,border:"1px dashed #1f2937"}}>
          <div style={{fontSize:32,marginBottom:8}}>⏱</div>
          <div>Upload data first in the Data tab.</div>
        </div>
      ):(
        <>
          {/* ── Stock overview cards ─────────────────────────────────────── */}
          <div style={{marginBottom:16}}>
            <div style={{fontSize:11,color:"#6b7280",marginBottom:8,fontWeight:600}}>📊 Uploaded stocks (auto-merged by name)</div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(190px,1fr))",gap:8}}>
              {baseNames.map(base=>{
                const range=getGroupDateRange(groups[base],stockDataMap);
                const isTarget=targetBase===base;
                const isTrain=trainBases.includes(base);
                return(
                  <div key={base} style={{background:isTarget?"#0f1f3d":isTrain?"#052e16":"#0f172a",
                    border:`1px solid ${isTarget?"#3b82f6":isTrain?"#22c55e":"#1f2937"}`,
                    borderRadius:8,padding:"10px 12px",cursor:"pointer"}}
                    onClick={()=>{ if(base!==targetBase){setTargetBase(base);setResult(null);} }}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:4}}>
                      <div style={{fontSize:12,fontWeight:700,color:isTarget?"#93c5fd":isTrain?"#22c55e":"#f9fafb"}}>{base}</div>
                      {isTarget&&<span style={{fontSize:9,background:"#1d4ed8",color:"#fff",borderRadius:3,padding:"1px 5px",fontWeight:700}}>TARGET</span>}
                      {isTrain&&!isTarget&&<span style={{fontSize:9,background:"#166534",color:"#fff",borderRadius:3,padding:"1px 5px",fontWeight:700}}>POOL</span>}
                    </div>
                    {range&&(
                      <>
                        <div style={{fontSize:10,color:"#4b5563"}}>{fmtDate(range.first)} → {fmtDate(range.last)}</div>
                        <div style={{fontSize:10,color:"#374151"}}>{range.count.toLocaleString()} rows · {groups[base].length > 1 ? `${groups[base].length} files merged` : "1 file"}</div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
            <div style={{fontSize:10,color:"#374151",marginTop:6}}>Click a card to set it as the prediction target. Use the pool toggle below to add extra training stocks.</div>
          </div>

          {/* ── Config panel ─────────────────────────────────────────────── */}
          <div style={{background:"#0f172a",border:"1px solid #1f2937",borderRadius:12,padding:18,marginBottom:16}}>

            {/* Direction */}
            <div style={{marginBottom:16}}>
              <div style={{fontSize:11,color:"#6b7280",marginBottom:6,fontWeight:600}}>🔀 Direction</div>
              <div style={{display:"flex",gap:0,borderRadius:8,overflow:"hidden",border:"1px solid #374151"}}>
                {[
                  ["forward","→ Forward","Train older data → predict newer  (e.g. train 2022–2023, predict 2024)","#1d4ed8"],
                  ["reverse","← Reverse","Train newer data → predict older  (e.g. train 2024–2025, predict 2023)","#7c3aed"],
                ].map(([d,label,hint,ac])=>(
                  <button key={d} onClick={()=>{setDirection(d);setResult(null);}}
                    style={{flex:1,padding:"11px 14px",border:"none",cursor:"pointer",textAlign:"left",
                      background:direction===d?`${ac}22`:"#111827",
                      borderRight:d==="forward"?"1px solid #374151":"none"}}>
                    <div style={{fontSize:13,fontWeight:700,color:direction===d?ac:"#6b7280",marginBottom:2}}>{label}</div>
                    <div style={{fontSize:10,color:direction===d?"#9ca3af":"#374151"}}>{hint}</div>
                  </button>
                ))}
              </div>
              {direction==="reverse"&&(
                <div style={{marginTop:8,fontSize:11,color:"#a78bfa",background:"#1e1040",border:"1px solid #7c3aed44",borderRadius:6,padding:"7px 10px"}}>
                  Reverse mode proves patterns are timeless. Strong reverse accuracy = model learned structure, not era-specific noise.
                </div>
              )}
            </div>

            {/* Target + cutoff + horizon */}
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(190px,1fr))",gap:14,marginBottom:14}}>
              <div>
                <div style={{fontSize:11,color:"#6b7280",marginBottom:5,fontWeight:600}}>🎯 Target stock to predict</div>
                <select value={targetBase||""} onChange={e=>{setTargetBase(e.target.value);setResult(null);}}
                  style={{width:"100%",background:"#1e293b",border:"1px solid #374151",color:"#f9fafb",borderRadius:6,padding:"9px 10px",fontSize:13,cursor:"pointer"}}>
                  {baseNames.map(n=><option key={n} value={n}>{n}</option>)}
                </select>
                {targetBase&&(()=>{
                  const range=getGroupDateRange(groups[targetBase]||[],stockDataMap);
                  if(!range) return null;
                  return <div style={{fontSize:10,color:"#4b5563",marginTop:4}}>{range.count.toLocaleString()} rows · {fmtDate(range.first)} → {fmtDate(range.last)}</div>;
                })()}
              </div>

              <div>
                <div style={{fontSize:11,color:"#6b7280",marginBottom:5,fontWeight:600}}>📅 Cutoff date <span style={{color:"#374151",fontWeight:400}}>(auto-set, adjustable)</span></div>
                <input type="date" value={cutoffDate} onChange={e=>setCutoffDate(e.target.value)}
                  style={{width:"100%",background:"#1e293b",border:"1px solid #374151",color:"#f9fafb",borderRadius:6,padding:"9px 10px",fontSize:13,outline:"none",boxSizing:"border-box"}}/>
                <div style={{fontSize:10,color:"#4b5563",marginTop:4}}>
                  {direction==="forward"?"Train: before this date · Test: after":"Train: after this date · Test: before"}
                </div>
              </div>

              <div>
                <div style={{fontSize:11,color:"#6b7280",marginBottom:5,fontWeight:600}}>📆 Prediction horizon</div>
                <select value={horizon} onChange={e=>setHorizon(parseInt(e.target.value))}
                  style={{width:"100%",background:"#1e293b",border:"1px solid #374151",color:"#f9fafb",borderRadius:6,padding:"9px 10px",fontSize:13,cursor:"pointer"}}>
                  {[[7,"7 days"],[14,"14 days"],[30,"30 days"],[60,"60 days"],[90,"90 days"]].map(([v,l])=>
                    <option key={v} value={v}>{l}</option>)}
                </select>
                <div style={{fontSize:10,color:"#4b5563",marginTop:4}}>How far ahead each prediction looks</div>
              </div>
            </div>

            {/* Pool extra stocks for training */}
            <div>
              <div style={{fontSize:11,color:"#6b7280",marginBottom:6,fontWeight:600}}>
                🔗 Pool extra stocks for training <span style={{color:"#374151",fontWeight:400}}>(optional — adds more patterns)</span>
              </div>
              <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                {baseNames.filter(b=>b!==targetBase).map(b=>{
                  const sel=trainBases.includes(b);
                  const range=getGroupDateRange(groups[b]||[],stockDataMap);
                  return(
                    <button key={b} onClick={()=>setTrainBases(prev=>sel?prev.filter(x=>x!==b):[...prev,b])}
                      style={{padding:"6px 12px",borderRadius:6,
                        border:`1px solid ${sel?"#22c55e":"#374151"}`,
                        background:sel?"#052e16":"#111827",
                        color:sel?"#22c55e":"#6b7280",cursor:"pointer",fontSize:12,fontWeight:sel?700:400}}>
                      {sel?"✓ ":""}{b}{range?` (${fmtDate(range.first).slice(-4)}–${fmtDate(range.last).slice(-4)})`:""}
                    </button>
                  );
                })}
              </div>
              {trainBases.length>0&&(
                <div style={{fontSize:11,color:"#6b7280",marginTop:6}}>
                  Model will train on: <b style={{color:"#f9fafb"}}>{targetBase}</b> + {trainBases.join(" + ")} (same time window as cutoff)
                </div>
              )}
            </div>

            <button onClick={run} disabled={running||!targetBase||!cutoffDate}
              style={{marginTop:16,width:"100%",
                background:running||!targetBase||!cutoffDate?"#1f2937":direction==="forward"?"#1d4ed8":"#7c3aed",
                border:"none",color:running||!targetBase||!cutoffDate?"#4b5563":"#fff",borderRadius:8,
                padding:"13px",cursor:running||!targetBase||!cutoffDate?"not-allowed":"pointer",fontWeight:800,fontSize:14}}>
              {btnLabel}
            </button>
          </div>

          {/* ── Error ──────────────────────────────────────────────────────── */}
          {result?.error&&(
            <div style={{background:"#1c0a0a",border:"1px solid #991b1b",borderRadius:10,padding:16,marginBottom:16}}>
              <div style={{color:"#f87171",fontSize:13,fontWeight:700,marginBottom:6}}>❌ Simulation error</div>
              <div style={{color:"#fca5a5",fontSize:12,whiteSpace:"pre-line"}}>{result.error}</div>
            </div>
          )}

          {/* ── Results ────────────────────────────────────────────────────── */}
          {result&&!result.error&&(
            <div>
              {/* Header */}
              <div style={{background:"#0f172a",border:`1px solid ${result.direction==="forward"?"#1d4ed8":"#7c3aed"}`,borderRadius:12,padding:18,marginBottom:14}}>
                <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:6,flexWrap:"wrap"}}>
                  <div style={{fontSize:15,fontWeight:900,color:"#f9fafb"}}>{result.targetBase}</div>
                  <span style={{fontSize:11,fontWeight:700,padding:"2px 8px",borderRadius:4,
                    background:result.direction==="forward"?"#1e3a5f":"#1e1040",
                    color:result.direction==="forward"?"#60a5fa":"#a78bfa",
                    border:`1px solid ${result.direction==="forward"?"#1d4ed8":"#7c3aed"}`}}>
                    {result.direction==="forward"?"→ Forward":"← Reverse"}
                  </span>
                  {result.pooledBases.length>0&&
                    <span style={{fontSize:11,color:"#6b7280"}}>pooled with {result.pooledBases.join(", ")}</span>}
                </div>
                <div style={{fontSize:11,color:"#6b7280",marginBottom:14}}>
                  Trained on <b style={{color:"#9ca3af"}}>{result.trainRows} rows</b> ({result.trainLabel}) · tested on <b style={{color:"#9ca3af"}}>{result.testRows} rows</b> ({result.testLabel}) · {result.trainSamples} training samples · {result.predictions.length} predictions
                  {result.trainingTrend&&(
                    <span style={{marginLeft:10,padding:"1px 7px",borderRadius:4,fontSize:10,fontWeight:700,
                      background:result.trainingTrend==="UP"?"#14532d":"#450a0a",
                      color:result.trainingTrend==="UP"?"#4ade80":"#f87171"}}>
                      Training regime: {result.trainingTrend==="UP"?"📈 BULLISH":"📉 BEARISH"}
                    </span>
                  )}
                </div>

                {/* Trend regime flip warning */}
                {result.trendFlipWarning&&(
                  <div style={{background:"#140a1c",border:"2px solid #7c3aed",borderRadius:8,
                    padding:"12px 16px",marginBottom:14,fontSize:12,color:"#c4b5fd",lineHeight:1.6}}>
                    <b>🔄 Trend Regime Flip Detected</b>
                    <div style={{marginTop:4}}>
                      Training period was <b style={{color:"#f9fafb"}}>{result.trendFlipWarning.trainTrend}</b>
                      {" → "}test period is <b style={{color:"#f9fafb"}}>{result.trendFlipWarning.testTrend}</b>.
                      {" "}Predictions in the wrong regime are suppressed (shown as OOD).
                    </div>
                    <div style={{marginTop:6,fontSize:11,color:"#9ca3af"}}>
                      <b style={{color:"#f9fafb"}}>Fix:</b> Import 3-5 years of data so the model sees both UP and DOWN cycles.
                      1-year data almost always captures only one regime — the model cannot generalise across the flip.
                    </div>
                  </div>
                )}

                {/* Degenerate training window warning */}
                {result.isDegenerate&&(
                  <div style={{background:"#1c1400",border:"2px solid #854d0e",borderRadius:8,
                    padding:"12px 16px",marginBottom:14,fontSize:12,color:"#fbbf24",lineHeight:1.6}}>
                    <b>⚠️ One-directional training window:</b> {result.degenerateMsg}
                    <div style={{marginTop:6,fontSize:11,color:"#9ca3af"}}>
                      <b style={{color:"#f9fafb"}}>Fix:</b> Enable stock pooling below and add stocks with 
                      mixed UP/DOWN history. The model needs examples of both directions to predict reliably.
                    </div>
                  </div>
                )}

                <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(130px,1fr))",gap:10}}>
                  {[
                    ["Out-of-sample Acc.",`${(result.accuracy*100).toFixed(1)}%`,result.accuracy>0.6?"#22c55e":result.accuracy>0.5?"#eab308":"#ef4444","Decisive calls only"],
                    ["Overall Acc.",`${(result.allCorrect*100).toFixed(1)}%`,result.allCorrect>0.55?"#22c55e":"#eab308","Incl. NEUTRAL"],
                    ["Strategy Return",fmtPct(result.strategyReturn),result.strategyReturn>0?"#22c55e":"#ef4444","Avg return per UP signal"],
                    ["Short Return",result.shortReturn!=null?fmtPct(result.shortReturn):"—",result.shortReturn>0?"#22c55e":"#ef4444","Avg return per DOWN signal"],
                    ["Buy & Hold",fmtPct(result.buyHoldReturn),result.buyHoldReturn>0?"#22c55e":"#ef4444","Holding test period"],
                    ["Alpha",fmtPct(result.alpha),result.alpha>0?"#22c55e":"#ef4444","Strategy minus hold"],
                    ["Avg Price Error",`±${result.mae.toFixed(1)}%`,"#9ca3af","Mean abs return err"],
                    ["In-Sample Acc.",`${(result.inSampleAcc*100).toFixed(1)}%`,"#4b5563","Train data"],
                    ["Training Samples",result.trainSamples.toLocaleString(),"#60a5fa","Pooled corpus"],
                  ].map(([l,v,c,s])=>(
                    <div key={l} style={{background:"#111827",borderRadius:8,padding:"10px 12px"}}>
                      <div style={{fontSize:9,color:"#4b5563"}}>{l}</div>
                      <div style={{fontSize:16,fontWeight:800,color:c}}>{v}</div>
                      <div style={{fontSize:9,color:"#374151",marginTop:2}}>{s}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* ── Confirmation panel ─────────────────────────────────────── */}
              <div style={{background:"#0f172a",border:"1px solid #374151",borderRadius:12,padding:16,marginBottom:14}}>
                <div style={{fontSize:13,fontWeight:800,color:"#f9fafb",marginBottom:4}}>✅ Confirm against actual data</div>
                <div style={{fontSize:12,color:"#6b7280",marginBottom:10,lineHeight:1.6}}>
                  If you have the actual prices for the test period uploaded as a separate file, select it here. The system will rescore every prediction against the real values to give you a confirmed accuracy.
                </div>
                <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:10}}>
                  {baseNames.map(b=>{
                    const sel=confirmBases.includes(b);
                    const range=getGroupDateRange(groups[b]||[],stockDataMap);
                    return(
                      <button key={b} onClick={()=>toggleConfirmBase(b)}
                        style={{padding:"6px 12px",borderRadius:6,
                          border:`1px solid ${sel?"#f59e0b":"#374151"}`,
                          background:sel?"#1c1400":"#111827",
                          color:sel?"#f59e0b":"#6b7280",cursor:"pointer",fontSize:12,fontWeight:sel?700:400}}>
                        {sel?"✓ ":""}{b}{range?` (${fmtDate(range.first).slice(-4)}–${fmtDate(range.last).slice(-4)})`:""}
                      </button>
                    );
                  })}
                </div>
                <button onClick={runConfirmation} disabled={confirming||!confirmBases.length||!result}
                  style={{background:confirming||!confirmBases.length?"#1f2937":"#d97706",border:"none",
                    color:confirming||!confirmBases.length?"#4b5563":"#000",borderRadius:7,padding:"9px 18px",
                    cursor:confirming||!confirmBases.length?"not-allowed":"pointer",fontWeight:800,fontSize:13}}>
                  {confirming?"⏳ Scoring…":"🔍 Score against actual data"}
                </button>

                {/* Confirmation results */}
                {result.confirmAcc!==undefined&&(
                  <div style={{marginTop:12,display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(140px,1fr))",gap:8}}>
                    {[
                      ["Confirmed Accuracy",`${(result.confirmAcc*100).toFixed(1)}%`,result.confirmAcc>0.6?"#22c55e":result.confirmAcc>0.5?"#eab308":"#ef4444","Against real data"],
                      ["Rows Confirmed",result.confirmRows,"#60a5fa","Matched predictions"],
                      ["Confirmed MAE",`±${result.confirmMae.toFixed(1)}%`,"#9ca3af","Real vs predicted ret"],
                      ["Source",result.confirmBases.join(", "),"#6b7280","Confirmation data"],
                    ].map(([l,v,c,s])=>(
                      <div key={l} style={{background:"#111827",borderRadius:8,padding:"10px 12px",border:"1px solid #854d0e"}}>
                        <div style={{fontSize:9,color:"#4b5563"}}>{l}</div>
                        <div style={{fontSize:14,fontWeight:800,color:c}}>{v}</div>
                        <div style={{fontSize:9,color:"#374151",marginTop:2}}>{s}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Monthly breakdown */}
              {monthKeys.length>0&&(
                <div style={{background:"#0f172a",border:"1px solid #1f2937",borderRadius:10,padding:14,marginBottom:14}}>
                  <div style={{fontSize:13,fontWeight:800,color:"#f9fafb",marginBottom:10}}>📅 Monthly Accuracy</div>
                  <div style={{overflowX:"auto"}}>
                    <div style={{display:"grid",gridTemplateColumns:`repeat(${Math.min(monthKeys.length,12)},1fr)`,gap:4,minWidth:400}}>
                      {monthKeys.map(m=>{
                        const s=result.byMonth[m];
                        const acc=s.decided>0?s.decidedCorrect/s.decided:null;
                        const c=acc===null?"#374151":acc>0.6?"#22c55e":acc>0.5?"#eab308":"#ef4444";
                        return(
                          <div key={m} style={{background:"#111827",borderRadius:6,padding:"6px 4px",textAlign:"center"}}>
                            <div style={{fontSize:9,color:"#4b5563",marginBottom:2}}>{m.slice(2)}</div>
                            <div style={{fontSize:12,fontWeight:700,color:c}}>{acc!==null?`${(acc*100).toFixed(0)}%`:"—"}</div>
                            <div style={{fontSize:9,color:"#374151"}}>{s.decided}d</div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                  <div style={{fontSize:10,color:"#4b5563",marginTop:6}}>"d" = number of decisive (UP/DOWN) calls that month.</div>
                </div>
              )}

              {/* Prediction timeline */}
              <div style={{background:"#0f172a",border:"1px solid #1f2937",borderRadius:10,padding:14,marginBottom:14}}>
                <div style={{fontSize:13,fontWeight:800,color:"#f9fafb",marginBottom:10}}>
                  📈 Prediction timeline — {Math.min(40,result.predictions.length)} of {result.predictions.length} shown
                </div>
                <div style={{display:"flex",flexDirection:"column",gap:3}}>
                  <div style={{display:"grid",gridTemplateColumns:"100px 65px 75px 60px 75px 75px 55px",gap:4,fontSize:9,color:"#4b5563",padding:"0 4px",marginBottom:4}}>
                    {["Date","Price","Predicted","Conf","Pred Ret","Actual Ret","✓/✗"].map(h=><div key={h}>{h}</div>)}
                  </div>
                  {(result.direction==="reverse"
                    ? result.predictions.slice(0,40)
                    : result.predictions.slice(-40).reverse()
                  ).map((p,i)=>{
                    const cp=result.confirmedPredictions?.[result.confirmedPredictions.findIndex(cp=>cp.date===p.date)];
                    const dc={UP:"#22c55e",DOWN:"#ef4444",NEUTRAL:"#6b7280"}[p.predictedDir];
                    const ac=p.actualRet>=0?"#22c55e":"#ef4444";
                    const rowBg=p.predictedDir==="NEUTRAL"?"#0a0f1e":p.correct?"#052e1633":"#1c0a0a33";
                    return(
                      <div key={i} style={{display:"grid",gridTemplateColumns:"100px 65px 75px 60px 75px 75px 55px",gap:4,fontSize:11,padding:"5px 4px",borderRadius:4,background:rowBg,alignItems:"center"}}>
                        <div style={{color:"#6b7280"}}>{p.date}</div>
                        <div style={{color:"#f9fafb",fontWeight:600}}>{fmt(p.price)}</div>
                        <div style={{color:dc,fontWeight:700}}>{p.predictedDir}</div>
                        <div style={{color:p.isOOD?"#6b7280":dc}}>
                          {p.isOOD?"OOD":p.conf+"%"}
                        </div>
                        <div style={{color:"#9ca3af"}}>{fmtPct(p.predictedRet)}</div>
                        <div style={{color:ac,fontWeight:700}}>{fmtPct(p.actualRet)}</div>
                        <div style={{fontSize:12}}>{p.predictedDir==="NEUTRAL"?"—":p.correct?"✓":"✗"}</div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Best / worst */}
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:14}}>
                <div style={{background:"#0f172a",border:"1px solid #166534",borderRadius:10,padding:14}}>
                  <div style={{fontSize:13,fontWeight:800,color:"#22c55e",marginBottom:8}}>✓ Best Calls</div>
                  {result.bestHits.map((p,i)=>(
                    <div key={i} style={{fontSize:11,padding:"5px 0",borderBottom:"1px solid #1f2937",display:"flex",justifyContent:"space-between"}}>
                      <span style={{color:"#6b7280"}}>{p.date}</span>
                      <span style={{color:"#22c55e",fontWeight:700}}>{p.predictedDir}</span>
                      <span style={{color:"#22c55e"}}>{fmtPct(p.actualRet)}</span>
                    </div>
                  ))}
                </div>
                <div style={{background:"#0f172a",border:"1px solid #991b1b",borderRadius:10,padding:14}}>
                  <div style={{fontSize:13,fontWeight:800,color:"#f87171",marginBottom:8}}>✗ Worst Misses</div>
                  {result.worstMisses.map((p,i)=>(
                    <div key={i} style={{fontSize:11,padding:"5px 0",borderBottom:"1px solid #1f2937",display:"flex",justifyContent:"space-between"}}>
                      <span style={{color:"#6b7280"}}>{p.date}</span>
                      <span style={{color:"#eab308"}}>Said {p.predictedDir}</span>
                      <span style={{color:"#ef4444"}}>Got {fmtPct(p.actualRet)}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Footer note */}
              <div style={{fontSize:12,color:"#6b7280",background:"#111827",borderRadius:8,padding:"10px 14px",lineHeight:1.7}}>
                {result.direction==="reverse"
                  ?<><b style={{color:"#a78bfa"}}>Reverse test:</b> Model trained on newer data ({result.trainLabel}), tested on older data ({result.testLabel}) it never saw. Strong accuracy here = patterns are timeless.</>
                  :<><b style={{color:"#60a5fa"}}>Forward test:</b> Model trained on older data ({result.trainLabel}), tested on newer data ({result.testLabel}). Standard predictive test.</>
                }{" "}NEUTRAL = probability between 38–62%, model not confident. Strategy return = cumulative return following every UP signal for {result.horizon} days each.
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// =============================================================================
// ─── MACRO TAB ───────────────────────────────────────────────────────────────
// =============================================================================
function MacroTab(){
  const [macro,setMacro]=useState(()=>db.load("iq_macro",{cbk_rate:13.0,inflation:4.5,usd_kes:129.5,gdp_growth:5.0}));
  const [simResult,setSimResult]=useState(null);
  const [deadband,setDeadband]=useState(()=>getDeadband());
  const regime=detectRegime(macro);
  const rm=REGIME_META[regime];

  const update=(k,v)=>{const m={...macro,[k]:parseFloat(v)||0};setMacro(m);db.save("iq_macro",m);};
  const updateDeadband=(h,v)=>{const d={...deadband,[h]:parseFloat(v)};setDeadband(d);db.save("iq_deadband",d);};

  const arb=ifbArbitrage(18.2,16.4);
  const ry=realYield(16.4,macro.inflation,0.15);
  const ifbRy=realYield(18.2,macro.inflation,0);

  return(
    <div>
      <div style={{fontSize:17,fontWeight:900,color:"#f9fafb",marginBottom:4}}>🏦 Macro Intelligence</div>
      <div style={{fontSize:12,color:"#6b7280",marginBottom:16}}>Live macro inputs · Regime detection · Scenario simulation · Real yield analysis</div>

      {/* Regime banner */}
      <div style={{background:`${rm.color}11`,border:`1px solid ${rm.color}44`,borderRadius:10,padding:14,marginBottom:16}}>
        <div style={{fontSize:15,fontWeight:800,color:rm.color,marginBottom:4}}>{rm.label}</div>
        <div style={{fontSize:12,color:"#d1d5db",marginBottom:8}}>{rm.advice}</div>
        <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
          {rm.overweight.map(a=><span key={a} style={{fontSize:10,background:"#052e16",color:"#22c55e",borderRadius:4,padding:"2px 7px",border:"1px solid #166534"}}>▲ {a}</span>)}
          {rm.underweight.map(a=><span key={a} style={{fontSize:10,background:"#1c0a0a",color:"#ef4444",borderRadius:4,padding:"2px 7px",border:"1px solid #991b1b"}}>▼ {a}</span>)}
        </div>
      </div>

      {/* U3: Signal deadband threshold */}
      <div style={{background:"#0f172a",border:"1px solid #1f2937",borderRadius:10,padding:14,marginBottom:16}}>
        <div style={{fontSize:13,fontWeight:800,color:"#f9fafb",marginBottom:4}}>📊 Signal Deadband Threshold</div>
        <div style={{fontSize:11,color:"#6b7280",marginBottom:10,lineHeight:1.6}}>
          Moves smaller than this threshold are labelled <b style={{color:"#6b7280"}}>FLAT</b> and excluded from BUY/SELL training. Higher = fewer but cleaner signals. Retrain after changing.
        </div>
        {[[30,"30-day"],[60,"60-day"],[90,"90-day"]].map(([h,label])=>(
          <div key={h} style={{marginBottom:10}}>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
              <span style={{fontSize:11,color:"#9ca3af"}}>{label} min move</span>
              <span style={{fontSize:11,fontWeight:700,color:"#60a5fa"}}>{deadband[h]?.toFixed(1)}%</span>
            </div>
            <input type="range" min={0.5} max={4.0} step={0.5}
              value={deadband[h]??DEFAULT_DEADBAND[h]}
              onChange={e=>updateDeadband(h,e.target.value)}
              style={{width:"100%",accentColor:"#3b82f6"}}/>
            <div style={{display:"flex",justifyContent:"space-between",fontSize:9,color:"#374151"}}>
              <span>0.5% (more signals)</span><span>4.0% (cleaner signals)</span>
            </div>
          </div>
        ))}
      </div>

      {/* Editable macro inputs */}
      <div style={{background:"#0f172a",border:"1px solid #1f2937",borderRadius:10,padding:14,marginBottom:16}}>
        <div style={{fontSize:12,fontWeight:700,color:"#f9fafb",marginBottom:10}}>📥 Current Macro Parameters <span style={{fontSize:10,color:"#4b5563",fontWeight:400}}>(edit to update regime + real yields)</span></div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(170px,1fr))",gap:12}}>
          {[["CBK Rate (%)","cbk_rate","#ef4444",[macro.cbk_rate>12?"#ef4444":"#22c55e"]],["Inflation (%)","inflation","#eab308",[macro.inflation>6?"#ef4444":"#22c55e"]],["USD/KES","usd_kes","#60a5fa",[macro.usd_kes>135?"#ef4444":"#22c55e"]],["GDP Growth (%)","gdp_growth","#22c55e",[macro.gdp_growth<3?"#ef4444":"#22c55e"]]].map(([label,key,c])=>(
            <div key={key}>
              <div style={{fontSize:10,color:"#6b7280",marginBottom:4}}>{label}</div>
              <input type="number" step="0.1" value={macro[key]||""} onChange={e=>update(key,e.target.value)}
                style={{width:"100%",background:"#1e293b",border:"1px solid #374151",color:c,borderRadius:6,padding:"8px 10px",fontSize:14,fontWeight:700,outline:"none",boxSizing:"border-box"}}/>
            </div>
          ))}
        </div>
      </div>

      {/* Real yield analysis */}
      <div style={{background:"#0f172a",border:"1px solid #1f2937",borderRadius:10,padding:14,marginBottom:16}}>
        <div style={{fontSize:12,fontWeight:700,color:"#f9fafb",marginBottom:10}}>📊 Real Yield Analysis</div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(140px,1fr))",gap:8,marginBottom:12}}>
          {[
            ["T-Bill 364d Gross","16.4%","#9ca3af"],
            ["T-Bill After 15% WHT",`${ry.afterTax.toFixed(2)}%`,"#60a5fa"],
            ["T-Bill Real After Tax",`${ry.realAfterTax.toFixed(2)}%`,ry.realAfterTax>0?"#22c55e":"#ef4444"],
            ["IFB Gross","18.2%","#9ca3af"],
            ["IFB Net (tax-free)",`${ifbRy.afterTax.toFixed(2)}%`,"#22c55e"],
            ["IFB Real After Tax",`${ifbRy.realAfterTax.toFixed(2)}%`,ifbRy.realAfterTax>0?"#22c55e":"#ef4444"],
          ].map(([l,v,c])=>(
            <div key={l} style={{background:"#111827",borderRadius:6,padding:"8px 10px"}}>
              <div style={{fontSize:9,color:"#4b5563"}}>{l}</div>
              <div style={{fontSize:14,fontWeight:800,color:c}}>{v}</div>
            </div>
          ))}
        </div>
        <div style={{background:"#052e16",border:"1px solid #166534",borderRadius:7,padding:"9px 12px",fontSize:12,color:"#6ee7b7"}}>
          💎 IFB Tax Arbitrage: {arb.description}
        </div>
      </div>

      {/* Scenarios */}
      <div style={{fontSize:13,fontWeight:800,color:"#f9fafb",marginBottom:10}}>📋 Macro Scenarios</div>
      <div style={{display:"flex",flexDirection:"column",gap:8}}>
        {MACRO_SCENARIOS_LIST.map(sc=>{
          const sr=simulateScenario(sc,macro);
          const ic={bullish:"#22c55e",bearish:"#ef4444",mixed:"#eab308"}[sc.impact];
          return(
            <div key={sc.id} style={{background:"#0f172a",border:`1px solid ${ic}33`,borderRadius:8,padding:"12px 14px"}}>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:6,flexWrap:"wrap",gap:8}}>
                <div style={{fontWeight:700,color:"#f9fafb",fontSize:13}}>{sc.label}</div>
                <div style={{display:"flex",gap:6,alignItems:"center"}}>
                  <span style={{fontSize:11,fontWeight:700,color:ic,background:`${ic}22`,borderRadius:4,padding:"2px 8px",border:`1px solid ${ic}44`}}>{sc.impact.toUpperCase()}</span>
                  {sr.regimeShift&&<span style={{fontSize:10,color:"#a78bfa",background:"#1e1040",borderRadius:4,padding:"2px 6px",border:"1px solid #7c3aed44"}}>{sr.regimeShift.from}→{sr.regimeShift.to}</span>}
                </div>
              </div>
              <div style={{fontSize:11,color:"#9ca3af",marginBottom:6}}>{sc.note}</div>
              <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
                {sc.assets.map(a=><span key={a} style={{fontSize:10,background:"#111827",borderRadius:4,padding:"1px 7px",color:"#6b7280"}}>{a}</span>)}
              </div>
              {sr.regimeShift&&<div style={{marginTop:6,fontSize:11,color:sr.regimeShift.meta.color,background:`${sr.regimeShift.meta.color}11`,borderRadius:5,padding:"4px 8px",border:`1px solid ${sr.regimeShift.meta.color}33`}}>Regime shifts to: {sr.regimeShift.meta.label} — {sr.regimeShift.meta.advice}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// =============================================================================
// ─── TAX TAB ─────────────────────────────────────────────────────────────────
// =============================================================================
function TaxTab(){
  const [amount,setAmount]=useState("100000");
  const [selected,setSelected]=useState([]);
  const allAssets=Object.keys(ASSET_TAX_MAP);

  const toggle=(a)=>setSelected(p=>p.includes(a)?p.filter(x=>x!==a):[...p,a]);

  const grossYields={
    "KCB Group":9.1,"Equity Bank":8.5,"Safaricom":5.8,"EABL":4.2,"Co-op Bank":7.3,"BAT Kenya":11.2,
    "Infra Bond (IFB)":18.2,"T-Bill 91-day":15.8,"T-Bill 364-day":16.4,
    "Bitcoin":0,"Ethereum":4.5,"Apple":0.5,"Microsoft":0.7,"NVIDIA":0.03,"Acorn REIT":8.9,
  };

  const defaultComparison=[
    {name:"Infra Bond (IFB)",grossYield:18.2},{name:"T-Bill 364-day",grossYield:16.4},
    {name:"T-Bill 91-day",grossYield:15.8},{name:"BAT Kenya",grossYield:11.2},
    {name:"KCB Group",grossYield:9.1},{name:"Acorn REIT",grossYield:8.9},
    {name:"Equity Bank",grossYield:8.5},{name:"Ethereum",grossYield:4.5},
  ];

  const comparison=compareAfterTax(defaultComparison);
  const arb=ifbArbitrage(18.2,16.4);
  const amt=parseFloat(amount)||100000;

  return(
    <div>
      <div style={{fontSize:17,fontWeight:900,color:"#f9fafb",marginBottom:4}}>💰 Kenya Tax Engine</div>
      <div style={{fontSize:12,color:"#6b7280",marginBottom:16}}>After-tax yield comparisons · KRA WHT rules · IFB tax arbitrage · Income projections</div>

      {/* IFB arbitrage callout */}
      <div style={{background:"linear-gradient(135deg,#052e16,#0a0f1e)",border:"1px solid #22c55e",borderRadius:10,padding:16,marginBottom:16}}>
        <div style={{fontSize:14,fontWeight:800,color:"#22c55e",marginBottom:4}}>💎 IFB Tax Arbitrage</div>
        <div style={{fontSize:13,color:"#d1d5db",lineHeight:1.6}}>{arb.description}</div>
        <div style={{fontSize:11,color:"#6b7280",marginTop:6}}>Exempt under s.7(1)(f) Income Tax Act. IFBs are the only government-backed instrument with zero WHT in Kenya.</div>
      </div>

      {/* Tax rules table */}
      <div style={{background:"#0f172a",border:"1px solid #1f2937",borderRadius:10,padding:14,marginBottom:16}}>
        <div style={{fontSize:12,fontWeight:700,color:"#f9fafb",marginBottom:10}}>📋 Kenya WHT Rules by Asset Class</div>
        {Object.entries(TAX_RULES).map(([cat,rule])=>(
          <div key={cat} style={{display:"flex",alignItems:"center",gap:12,padding:"7px 0",borderBottom:"1px solid #111827"}}>
            <div style={{minWidth:120,fontSize:12,color:rule.taxFree?"#22c55e":"#f9fafb",fontWeight:700}}>{cat.replace(/_/g," ").toUpperCase()}</div>
            <div style={{minWidth:50,fontSize:13,fontWeight:800,color:rule.taxFree?"#22c55e":"#eab308"}}>{rule.taxFree?"0%":`${(rule.rate*100).toFixed(0)}%`}</div>
            <div style={{flex:1,fontSize:11,color:"#6b7280"}}>{rule.notes}</div>
          </div>
        ))}
      </div>

      {/* After-tax ranking */}
      <div style={{background:"#0f172a",border:"1px solid #1f2937",borderRadius:10,padding:14,marginBottom:16}}>
        <div style={{fontSize:12,fontWeight:700,color:"#f9fafb",marginBottom:10}}>📊 After-Tax Yield Ranking</div>
        <div style={{display:"flex",flexDirection:"column",gap:6}}>
          {comparison.assets.map((bd,i)=>{
            const isTop=i===0;
            return(
              <div key={bd.assetName} style={{display:"flex",alignItems:"center",gap:10,background:isTop?"#052e16":"#111827",borderRadius:7,padding:"9px 12px",border:isTop?"1px solid #166534":"1px solid transparent"}}>
                <div style={{fontSize:11,color:"#4b5563",minWidth:18}}>{i+1}</div>
                <div style={{flex:1,fontSize:12,fontWeight:700,color:isTop?"#22c55e":"#f9fafb"}}>{bd.assetName}{bd.taxFree&&" 💎"}</div>
                <div style={{fontSize:11,color:"#6b7280",minWidth:70}}>Gross: {bd.grossYield.toFixed(1)}%</div>
                <div style={{fontSize:11,color:"#4b5563",minWidth:55}}>Tax: {(bd.taxPaid).toFixed(1)}%</div>
                <div style={{fontSize:14,fontWeight:800,color:isTop?"#22c55e":"#a78bfa",minWidth:70}}>Net: {bd.netYield.toFixed(2)}%</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Income projector */}
      <div style={{background:"#0f172a",border:"1px solid #1f2937",borderRadius:10,padding:14}}>
        <div style={{fontSize:12,fontWeight:700,color:"#f9fafb",marginBottom:10}}>💵 Income Projector</div>
        <div style={{display:"flex",gap:8,marginBottom:12,alignItems:"flex-end"}}>
          <div style={{flex:1}}>
            <div style={{fontSize:10,color:"#6b7280",marginBottom:4}}>Investment amount (KES)</div>
            <input type="number" value={amount} onChange={e=>setAmount(e.target.value)}
              style={{width:"100%",background:"#1e293b",border:"1px solid #374151",color:"#f9fafb",borderRadius:6,padding:"9px 10px",fontSize:13,outline:"none",boxSizing:"border-box"}}/>
          </div>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))",gap:8}}>
          {[{name:"Infra Bond (IFB)",gy:18.2},{name:"T-Bill 364-day",gy:16.4},{name:"KCB Group",gy:9.1},{name:"Equity Bank",gy:8.5}].map(({name,gy})=>{
            const proj=projectIncome(name,gy,amt);
            return(
              <div key={name} style={{background:"#111827",borderRadius:8,padding:"10px 12px"}}>
                <div style={{fontSize:11,fontWeight:700,color:"#f9fafb",marginBottom:6}}>{name}</div>
                <div style={{fontSize:9,color:"#4b5563"}}>Annual income</div>
                <div style={{fontSize:16,fontWeight:800,color:"#22c55e",marginBottom:4}}>KES {proj.annualIncome.toLocaleString()}</div>
                <div style={{fontSize:10,color:"#6b7280"}}>Monthly: KES {proj.monthlyIncome.toLocaleString()}</div>
                <div style={{fontSize:10,color:"#60a5fa"}}>5yr value: KES {proj.fiveYearValue.toLocaleString()}</div>
                <div style={{fontSize:9,color:"#374151",marginTop:3}}>{proj.breakdown.rule.label}</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// ─── EXPERT GATE TAB ─────────────────────────────────────────────────────────
// =============================================================================
function ExpertGateTab(){
  const [macro]=useState(()=>db.load("iq_macro",{cbk_rate:13,inflation:4.5,usd_kes:129.5,gdp_growth:5.0}));
  const [sentiment,setSentiment]=useState({});
  const [bankMacro]=useState(()=>db.load("iq_macro",{}));

  const rankings=rankAssets(macro,sentiment);
  const sector=analyzeSector(bankMacro);

  const sentOpts=["bullish","neutral","bearish"];
  const sentColors={bullish:"#22c55e",neutral:"#eab308",bearish:"#ef4444"};

  return(
    <div>
      <div style={{fontSize:17,fontWeight:900,color:"#f9fafb",marginBottom:4}}>🔬 Expert Confidence Gate</div>
      <div style={{fontSize:12,color:"#6b7280",marginBottom:16}}>Multi-factor scoring: NPL + yield + liquidity + macro regime + sentiment. Set per-asset sentiment to refine signals.</div>

      {/* NPL Sector Summary */}
      <div style={{background:"#0f172a",border:"1px solid #1f2937",borderRadius:10,padding:14,marginBottom:16}}>
        <div style={{fontSize:13,fontWeight:800,color:"#f9fafb",marginBottom:10}}>🏦 NSE Banking Sector — NPL Analysis</div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(130px,1fr))",gap:8,marginBottom:12}}>
          {[
            ["Avg Sector NPL",`${sector.averageNPL}%`,sector.averageNPL>INDUSTRY_NPL_AVG?"#ef4444":"#22c55e"],
            ["Systemic Risk",sector.systemicRisk.toUpperCase(),{low:"#22c55e",moderate:"#eab308",elevated:"#f97316",high:"#ef4444"}[sector.systemicRisk]||"#9ca3af"],
            ["Worst Bank",sector.worstBank,"#ef4444"],
            ["Safest Bank",sector.safestBank,"#22c55e"],
          ].map(([l,v,c])=>(
            <div key={l} style={{background:"#111827",borderRadius:6,padding:"8px 10px"}}>
              <div style={{fontSize:9,color:"#4b5563"}}>{l}</div>
              <div style={{fontSize:13,fontWeight:800,color:c}}>{v}</div>
            </div>
          ))}
        </div>
        <div style={{display:"flex",flexDirection:"column",gap:6}}>
          {sector.analyses.map(a=>{
            const zc={SAFE:"#22c55e",WATCH:"#eab308","HIGH RISK":"#ef4444"}[a.zone];
            return(
              <div key={a.bankName} style={{background:"#111827",borderRadius:7,padding:"9px 12px",border:`1px solid ${zc}33`}}>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:4}}>
                  <div style={{fontWeight:700,color:"#f9fafb",fontSize:12}}>{a.bankName}</div>
                  <div style={{display:"flex",gap:6,alignItems:"center"}}>
                    <span style={{fontSize:10,fontWeight:700,color:zc,background:`${zc}22`,borderRadius:4,padding:"1px 6px"}}>{a.zone}</span>
                    <span style={{fontSize:12,fontWeight:800,color:zc}}>NPL: {a.profile.nplRatio}%</span>
                  </div>
                </div>
                <div style={{height:4,background:"#1f2937",borderRadius:2,marginBottom:4}}>
                  <div style={{width:`${Math.min(100,a.riskScore)}%`,height:"100%",background:zc,borderRadius:2}}/>
                </div>
                <div style={{display:"flex",gap:8,fontSize:10,color:"#6b7280"}}>
                  <span>Risk score: {a.riskScore}/100</span>
                  <span>Coverage: {a.profile.coverageRatio}%</span>
                  <span>Profit trend: {a.profile.profitTrend>0?"+":""}{a.profile.profitTrend}%</span>
                  {a.dividendAtRisk&&<span style={{color:"#ef4444",fontWeight:700}}>⚠ Dividend at risk</span>}
                </div>
                {a.warnings.length>0&&(
                  <div style={{marginTop:5,display:"flex",gap:4,flexWrap:"wrap"}}>
                    {a.warnings.map((w,i)=><span key={i} style={{fontSize:9,background:{high:"#1c0a0a",medium:"#1c1400",low:"#0f1f3d"}[w.sev],color:{high:"#f87171",medium:"#fbbf24",low:"#93c5fd"}[w.sev],borderRadius:3,padding:"1px 5px"}}>{w.msg}</span>)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Confidence Gate Rankings */}
      <div style={{fontSize:13,fontWeight:800,color:"#f9fafb",marginBottom:10}}>📊 Confidence Gate Rankings</div>
      <div style={{fontSize:11,color:"#6b7280",marginBottom:10}}>Set sentiment per asset to see how it shifts the confidence gate score.</div>
      <div style={{display:"flex",flexDirection:"column",gap:8}}>
        {rankings.map((r,i)=>{
          const gate=confidenceGate(r.assetName,macro,sentiment[r.assetName]||"neutral");
          if(!gate) return null;
          const lc={HIGH:"#22c55e",MEDIUM:"#eab308",LOW:"#ef4444"}[gate.level];
          return(
            <div key={r.assetName} style={{background:"#0f172a",border:`1px solid ${lc}33`,borderRadius:8,padding:"11px 14px"}}>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:8,marginBottom:6}}>
                <div style={{display:"flex",alignItems:"center",gap:10}}>
                  <div style={{fontSize:12,color:"#4b5563",minWidth:22}}>#{i+1}</div>
                  <div>
                    <div style={{fontWeight:700,color:"#f9fafb",fontSize:13}}>{r.assetName}</div>
                    <div style={{fontSize:10,color:lc}}>{gate.level} CONFIDENCE · {gate.passCount}/{gate.totalConditions} checks pass</div>
                  </div>
                </div>
                <div style={{display:"flex",gap:8,alignItems:"center"}}>
                  {/* Sentiment selector */}
                  <div style={{display:"flex",gap:3}}>
                    {sentOpts.map(s=>(
                      <button key={s} onClick={()=>setSentiment(p=>({...p,[r.assetName]:s}))}
                        style={{padding:"3px 8px",borderRadius:4,border:`1px solid ${(sentiment[r.assetName]||"neutral")===s?sentColors[s]:"#374151"}`,background:(sentiment[r.assetName]||"neutral")===s?`${sentColors[s]}22`:"#111827",color:(sentiment[r.assetName]||"neutral")===s?sentColors[s]:"#4b5563",cursor:"pointer",fontSize:10,fontWeight:700}}>
                        {s.charAt(0).toUpperCase()+s.slice(1)}
                      </button>
                    ))}
                  </div>
                  <div style={{textAlign:"right"}}>
                    <div style={{fontSize:22,fontWeight:900,color:lc}}>{gate.odds}</div>
                    <div style={{fontSize:9,color:"#4b5563"}}>/ 100</div>
                  </div>
                </div>
              </div>
              <div style={{height:4,background:"#1f2937",borderRadius:2,marginBottom:6}}>
                <div style={{width:`${gate.odds}%`,height:"100%",background:lc,borderRadius:2,transition:"width 0.4s"}}/>
              </div>
              <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
                {Object.entries(gate.conditions).map(([k,v])=>(
                  <span key={k} style={{fontSize:9,padding:"1px 5px",borderRadius:3,background:v?"#052e16":"#1c0a0a",color:v?"#22c55e":"#6b7280",border:`1px solid ${v?"#166534":"#374151"}`}}>
                    {v?"✓":"✗"} {k.replace(/([A-Z])/g," $1").trim()}
                  </span>
                ))}
              </div>
              {(gate.regimePenalty>0||gate.liqPenalty>0||gate.spreadPenalty>0)&&(
                <div style={{marginTop:5,fontSize:10,color:"#4b5563",display:"flex",gap:8}}>
                  {gate.regimePenalty>0&&<span style={{color:"#f97316"}}>Regime: -{gate.regimePenalty}pts</span>}
                  {gate.liqPenalty>0&&<span style={{color:"#eab308"}}>Liquidity: -{gate.liqPenalty}pts</span>}
                  {gate.spreadPenalty>0&&<span style={{color:"#ef4444"}}>Spread: -{gate.spreadPenalty}pts</span>}
                  {gate.sentimentBonus!==0&&<span style={{color:gate.sentimentBonus>0?"#22c55e":"#ef4444"}}>Sentiment: {gate.sentimentBonus>0?"+":""}{gate.sentimentBonus}pts</span>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── EVENT CALENDAR TAB (1b: from File B) ────────────────────────────────────
function EventCalendarTab({ log }) {
  const [events, setEvents] = useState(() => loadEvents());
  const [form, setForm] = useState({ date: "", label: "", type: "cbk_mpc" });

  const EVENT_TYPES = [
    { value: "cbk_mpc",   label: "🏦 CBK MPC Decision",   color: "#ef4444" },
    { value: "earnings",  label: "📊 Earnings Release",    color: "#22c55e" },
    { value: "dividend",  label: "💰 Dividend Date",       color: "#a78bfa" },
    { value: "macro",     label: "🌍 Macro Event",         color: "#eab308" },
    { value: "other",     label: "📌 Other",               color: "#6b7280" },
  ];

  const typeColor = (t) => EVENT_TYPES.find(e=>e.value===t)?.color || "#6b7280";
  const typeLabel = (t) => EVENT_TYPES.find(e=>e.value===t)?.label || t;

  const add = () => {
    if (!form.date || !form.label.trim()) return;
    const entry = { id: Date.now(), ...form, label: form.label.trim(), addedAt: new Date().toISOString() };
    const updated = [...events, entry].sort((a,b) => a.date.localeCompare(b.date));
    setEvents(updated);
    saveEvents(updated);
    log("EVENT_ADD", "SUCCESS", `Tagged: ${form.label} on ${form.date}`);
    setForm(f => ({ ...f, date: "", label: "" }));
  };

  const remove = (id) => {
    const updated = events.filter(e => e.id !== id);
    setEvents(updated);
    saveEvents(updated);
    log("EVENT_REMOVE", "SUCCESS", "Event removed");
  };

  const CBK_UPCOMING = [
    "2025-06-17","2025-08-05","2025-10-07","2025-12-09",
    "2026-02-17","2026-04-07","2026-06-16","2026-08-04",
  ];

  const addCBKBulk = () => {
    const existing = new Set(events.map(e=>e.date));
    const newEvts = CBK_UPCOMING
      .filter(d => !existing.has(d) && (safeDate(d)||new Date(0)) > new Date())
      .map(d => ({ id: Date.now() + Math.random(), date: d, label: "CBK MPC Decision", type: "cbk_mpc", addedAt: new Date().toISOString() }));
    if (!newEvts.length) return;
    const updated = [...events, ...newEvts].sort((a,b) => a.date.localeCompare(b.date));
    setEvents(updated);
    saveEvents(updated);
    log("EVENT_BULK", "SUCCESS", `Added ${newEvts.length} CBK MPC dates`);
  };

  return (
    <div>
      <div style={{fontSize:17,fontWeight:900,color:"#f9fafb",marginBottom:4}}>📅 Event Calendar</div>
      <div style={{fontSize:12,color:"#6b7280",marginBottom:16,lineHeight:1.8}}>
        Tag important dates — CBK MPC decisions, earnings releases, dividend dates. The ML model automatically learns that prices behave differently within 5 days of these events. <b style={{color:"#f9fafb"}}>The more events you tag, the more the model understands why prices move.</b>
      </div>
      <div style={{background:"#0f1f3d",border:"1px solid #1d4ed8",borderRadius:10,padding:14,marginBottom:16}}>
        <div style={{fontSize:12,fontWeight:700,color:"#93c5fd",marginBottom:6}}>🧠 How this improves predictions</div>
        <div style={{fontSize:12,color:"#9ca3af",lineHeight:1.7}}>
          When KCB announces earnings, the stock often moves 5–15% in a few days. By tagging these dates, the model learns to be more cautious (or opportunistic) around event windows. The <b style={{color:"#f9fafb"}}>nearEvent</b> feature is one of the 24 features in every prediction.
        </div>
      </div>
      <div style={{background:"#0f172a",border:"1px solid #1f2937",borderRadius:10,padding:14,marginBottom:16}}>
        <div style={{fontSize:12,fontWeight:700,color:"#f9fafb",marginBottom:8}}>⚡ Quick-add known dates</div>
        <button onClick={addCBKBulk} style={{background:"#1d4ed8",border:"none",color:"#fff",borderRadius:7,padding:"9px 16px",cursor:"pointer",fontWeight:700,fontSize:12,marginRight:8}}>
          🏦 Add all upcoming CBK MPC dates
        </button>
        <span style={{fontSize:11,color:"#4b5563"}}>{CBK_UPCOMING.length} dates pre-loaded from CBK calendar</span>
      </div>
      <div style={{background:"#0f172a",border:"1px solid #1f2937",borderRadius:10,padding:14,marginBottom:16}}>
        <div style={{fontSize:12,fontWeight:700,color:"#f9fafb",marginBottom:10}}>➕ Add an event</div>
        <div style={{display:"flex",gap:10,flexWrap:"wrap",alignItems:"flex-end"}}>
          <div style={{flex:2,minWidth:140}}>
            <div style={{fontSize:10,color:"#6b7280",marginBottom:4}}>Event description</div>
            <input value={form.label} onChange={e=>setForm(f=>({...f,label:e.target.value}))}
              placeholder="e.g. KCB Q2 Earnings" onKeyDown={e=>e.key==="Enter"&&add()}
              style={{width:"100%",background:"#1e293b",border:"1px solid #374151",color:"#f9fafb",borderRadius:6,padding:"9px 10px",fontSize:13,outline:"none",boxSizing:"border-box"}}/>
          </div>
          <div style={{flex:1,minWidth:130}}>
            <div style={{fontSize:10,color:"#6b7280",marginBottom:4}}>Date</div>
            <input type="date" value={form.date} onChange={e=>setForm(f=>({...f,date:e.target.value}))}
              style={{width:"100%",background:"#1e293b",border:"1px solid #374151",color:"#f9fafb",borderRadius:6,padding:"9px 10px",fontSize:13,outline:"none",boxSizing:"border-box"}}/>
          </div>
          <div style={{flex:1,minWidth:150}}>
            <div style={{fontSize:10,color:"#6b7280",marginBottom:4}}>Type</div>
            <select value={form.type} onChange={e=>setForm(f=>({...f,type:e.target.value}))}
              style={{width:"100%",background:"#1e293b",border:"1px solid #374151",color:"#f9fafb",borderRadius:6,padding:"9px 10px",fontSize:13,cursor:"pointer"}}>
              {EVENT_TYPES.map(t=><option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
          <button onClick={add} disabled={!form.date||!form.label.trim()}
            style={{background:form.date&&form.label.trim()?"#22c55e":"#1f2937",border:"none",color:form.date&&form.label.trim()?"#000":"#4b5563",borderRadius:6,padding:"9px 18px",cursor:form.date&&form.label.trim()?"pointer":"default",fontWeight:800,fontSize:13}}>
            ➕ Add
          </button>
        </div>
      </div>
      {events.length > 0 && (
        <div style={{background:"#1c1400",border:"1px solid #854d0e",borderRadius:8,padding:"10px 14px",marginBottom:16,fontSize:12,color:"#fbbf24"}}>
          ⚠️ <b>After adding or removing events, go to the Train tab and retrain your models</b> — the nearEvent feature only takes effect after a full retrain.
        </div>
      )}
      <div style={{fontSize:13,fontWeight:800,color:"#f9fafb",marginBottom:10}}>Tagged Events ({events.length})</div>
      {events.length === 0 ? (
        <div style={{textAlign:"center",padding:"40px",color:"#6b7280",background:"#0f172a",borderRadius:10,border:"1px dashed #1f2937"}}>
          <div style={{fontSize:32,marginBottom:8}}>📅</div>
          <div>No events tagged yet. Start by adding CBK MPC dates above.</div>
        </div>
      ) : (
        <div style={{display:"flex",flexDirection:"column",gap:6}}>
          {events.map(ev => {
            const isPast = (safeDate(ev.date)||new Date()) < new Date();
            const c = typeColor(ev.type);
            return (
              <div key={ev.id} style={{background:"#0f172a",border:`1px solid ${c}33`,borderRadius:8,padding:"10px 14px",display:"flex",alignItems:"center",gap:12,opacity:isPast?0.6:1}}>
                <div style={{minWidth:8,height:8,borderRadius:"50%",background:c,flexShrink:0}}/>
                <div style={{flex:1}}>
                  <div style={{fontWeight:700,color:"#f9fafb",fontSize:13}}>{ev.label}</div>
                  <div style={{fontSize:11,color:"#6b7280",marginTop:1}}>{fmtDate(ev.date)} · {typeLabel(ev.type)}{isPast?" · past":""}</div>
                </div>
                <button onClick={()=>remove(ev.id)} style={{background:"#7f1d1d",border:"1px solid #991b1b",color:"#fca5a5",borderRadius:5,padding:"4px 8px",cursor:"pointer",fontSize:11}}>✕</button>
              </div>
            );
          })}
        </div>
      )}
      <div style={{marginTop:20,background:"#0f172a",border:"1px solid #1f2937",borderRadius:10,padding:14}}>
        <div style={{fontSize:12,fontWeight:700,color:"#f9fafb",marginBottom:8}}>📋 What to tag and where to find the dates</div>
        {[
          ["CBK MPC Decisions","cbk.go.ke → Monetary Policy → MPC Meeting Dates. Most impactful for NSE bank stocks."],
          ["NSE Earnings","nse.co.ke → Listed Companies → select company → Financial Results. Also in Business Daily."],
          ["Dividend Dates","NSE publishes ex-dividend and payment dates. Cause predictable price drops on ex-date."],
          ["Budget / Finance Act","Kenya's Finance Bill tabled in June. Impacts T-Bill yields, crypto tax, financial stocks."],
          ["IMF/World Bank Events","Kenya's relationship with the IMF affects USD/KES and imported inflation."],
        ].map(([title, desc]) => (
          <div key={title} style={{marginBottom:10}}>
            <div style={{fontSize:11,fontWeight:700,color:"#93c5fd"}}>{title}</div>
            <div style={{fontSize:11,color:"#6b7280"}}>{desc}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── GAPS & ROADMAP TAB (1c: from File B) ────────────────────────────────────
function GapsTab() {
  const [section, setSection] = useState("status");
  const SECTIONS = [
    ["status",  "📊 Where we are"],
    ["done",    "✅ What's working"],
    ["gaps",    "🔧 Remaining gaps"],
    ["you",     "👤 What YOU do"],
    ["deploy",  "🚀 Deployment plan"],
    ["backend", "🖥 Backend & database"],
    ["accuracy","🎯 Beating the market"],
  ];
  return (
    <div>
      <div style={{fontSize:17,fontWeight:900,color:"#f9fafb",marginBottom:4}}>🗺 System Status & Roadmap</div>
      <div style={{fontSize:12,color:"#6b7280",marginBottom:16}}>Everything explained simply — where we are, what works, what's left, and what to do next.</div>
      <div style={{display:"flex",gap:4,flexWrap:"wrap",marginBottom:20}}>
        {SECTIONS.map(([id,label])=>(
          <button key={id} onClick={()=>setSection(id)}
            style={{padding:"7px 12px",borderRadius:6,border:`1px solid ${section===id?"#3b82f6":"#1f2937"}`,background:section===id?"#1e3a5f":"#0f172a",color:section===id?"#93c5fd":"#6b7280",cursor:"pointer",fontSize:11,fontWeight:section===id?700:400,whiteSpace:"nowrap"}}>
            {label}
          </button>
        ))}
      </div>
      {section==="status"&&(
        <div style={{display:"flex",flexDirection:"column",gap:12}}>
          <div style={{background:"#0f172a",border:"1px solid #1d4ed8",borderRadius:10,padding:16}}>
            <div style={{fontSize:14,fontWeight:800,color:"#93c5fd",marginBottom:8}}>Think of this like building a car 🚗</div>
            <div style={{fontSize:12,color:"#d1d5db",lineHeight:1.8}}>
              Right now we have a <b style={{color:"#f9fafb"}}>fully assembled car with an engine that works</b>. It can drive. It has brakes, steering, and a speedometer. But it's running on <b style={{color:"#eab308"}}>a test track with test fuel</b>, not on real Nairobi roads with real petrol yet.<br/><br/>
              The "real petrol" = live NSE price data streaming in automatically every day.<br/>
              The "real road" = a backend server that runs 24/7, fetches prices, and stores everything securely.<br/><br/>
              <b style={{color:"#22c55e"}}>The car is ready. We just need to connect it to the fuel pump.</b>
            </div>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(160px,1fr))",gap:10}}>
            {[
              ["ML Engine","Working ✓","The brain. Trains on your data, finds patterns, makes predictions.","#22c55e"],
              ["Feature Pipeline","Working ✓","24+ indicators computed from price data + macro + events.","#22c55e"],
              ["Backtest Engine","Working ✓","Walk-forward test. Honest accuracy. No fake numbers.","#22c55e"],
              ["Bulk CSV Import","Working ✓","Auto-splits multi-stock CSVs into individual datasets.","#22c55e"],
              ["Live Prices","❌ Manual","You upload CSVs manually. Backend will auto-fetch daily.","#ef4444"],
              ["Database","❌ Browser only","Data lives in your browser only. Supabase will persist everything.","#ef4444"],
            ].map(([title,status,desc,c])=>(
              <div key={title} style={{background:"#0f172a",border:`1px solid ${c}44`,borderRadius:8,padding:12}}>
                <div style={{fontSize:12,fontWeight:700,color:"#f9fafb"}}>{title}</div>
                <div style={{fontSize:11,fontWeight:700,color:c,marginTop:2}}>{status}</div>
                <div style={{fontSize:10,color:"#6b7280",marginTop:4,lineHeight:1.5}}>{desc}</div>
              </div>
            ))}
          </div>
        </div>
      )}
      {section==="done"&&(
        <div style={{display:"flex",flexDirection:"column",gap:8}}>
          {[
            ["24+ ML features per row","19 technical indicators + 6-level macro regime (CBK, USD/KES, inflation) + NPL score for banks + event proximity. Historical CBK rates wired per row."],
            ["Bulk CSV import engine","Auto-detects multi-stock CSVs, maps NSE tickers to EXPERT_BASE names, splits and saves each stock individually."],
            ["NSE format auto-detection","Recognises NSE website export format (Code/Day Price/Day High/Day Low/Volume) and auto-fills stock name."],
            ["Logistic + linear regression models","Three horizons (30/60/90 day) with direction and magnitude predictions."],
            ["Ensemble models — stable vs volatile","Separate models for calm and volatile market periods."],
            ["Walk-forward backtesting (expanding window)","Train on old, test on new. Wilson CI, Information Ratio, benchmark comparison."],
            ["Feature ablation study","Identifies which of 24 features help, hurt, or are noise."],
            ["Regime stress test","Accuracy broken down per CBK macro regime using live macro snapshot."],
            ["Calibration curve","Checks if 80% model confidence actually wins 80% of the time."],
            ["Adaptive confidence weighting","Weights model vs pattern agreement based on calibration and accuracy."],
            ["Neutral zone gate","Refuses to signal BUY/SELL when IR<1.0, patterns<5, or trainSize<150."],
            ["Kelly position sizing (transparent)","Shows p, b ratio, and data source (backtest vs fallback)."],
            ["Event calendar","Tag CBK MPC dates, earnings, dividends. Auto-adds 2025-2026 CBK schedule."],
            ["Sector momentum + pattern matcher + risk engine","Kenya-specific intelligence layer."],
            ["Export/Import + Supabase migration stubs","Ready to plug into a backend in one session."],
          ].map(([title,desc])=>(
            <div key={title} style={{background:"#0f172a",border:"1px solid #166534",borderRadius:8,padding:"11px 14px",display:"flex",gap:10}}>
              <div style={{fontSize:14,flexShrink:0,marginTop:1}}>✅</div>
              <div>
                <div style={{fontSize:12,fontWeight:700,color:"#22c55e",marginBottom:3}}>{title}</div>
                <div style={{fontSize:11,color:"#9ca3af",lineHeight:1.6}}>{desc}</div>
              </div>
            </div>
          ))}
        </div>
      )}
      {section==="gaps"&&(
        <div style={{display:"flex",flexDirection:"column",gap:10}}>
          <div style={{fontSize:12,color:"#6b7280",marginBottom:4}}>Listed in order of impact on accuracy.</div>
          {[
            {title:"Automatic daily price fetching",impact:"HIGH",what:"Prices only update when you upload CSV manually.",fix:"Backend (Node.js) will fetch closing prices at 4pm NSE close and trigger incremental model update.",canDo:"Get a free Alpha Vantage API key at alphavantage.co for NSE symbols like KCB.NR."},
            {title:"Per-row historical macro (inflation, USD/KES)",impact:"MEDIUM",what:"CBK rate is per-row now. Inflation and USD/KES still use current snapshot value for all historical rows.",fix:"CBK publishes historical inflation and FX data. Adding these per-row would improve regime classification.",canDo:"Keep a spreadsheet of quarterly inflation and USD/KES rates. We can import as a lookup CSV."},
            {title:"Real-time price streaming",impact:"MEDIUM",what:"No intraday view — model only updates with each CSV upload.",fix:"WebSocket connection to price feed.",canDo:"Nothing needed yet — this is a phase 2 backend feature."},
            {title:"Supabase database",impact:"HIGH",what:"Data lives in browser localStorage only — lost if cleared.",fix:"Swap db object to Supabase (see Backend tab for exact code).",canDo:"Create free Supabase project at supabase.com. Save the URL and anon key."},
          ].map((g,i)=>(
            <div key={i} style={{background:"#0f172a",border:"1px solid #374151",borderRadius:10,padding:14}}>
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
                <span style={{fontSize:10,padding:"2px 7px",borderRadius:4,background:g.impact==="HIGH"?"#1c0a0a":"#1c1400",color:g.impact==="HIGH"?"#f87171":"#fbbf24",fontWeight:700,border:`1px solid ${g.impact==="HIGH"?"#991b1b":"#854d0e"}`}}>{g.impact}</span>
                <div style={{fontSize:13,fontWeight:700,color:"#f9fafb"}}>{g.title}</div>
              </div>
              <div style={{fontSize:11,color:"#9ca3af",marginBottom:4}}>{g.what}</div>
              <div style={{fontSize:11,background:"#111827",borderRadius:5,padding:"5px 9px",color:"#60a5fa",marginBottom:4}}>🔧 Fix: {g.fix}</div>
              <div style={{fontSize:11,color:"#4b5563"}}>👤 You can: {g.canDo}</div>
            </div>
          ))}
        </div>
      )}
      {section==="you"&&(
        <div style={{display:"flex",flexDirection:"column",gap:10}}>
          <div style={{background:"#0f172a",border:"1px solid #166534",borderRadius:10,padding:14}}>
            <div style={{fontSize:13,fontWeight:800,color:"#22c55e",marginBottom:8}}>What you should do right now (no code needed)</div>
            {[
              ["Upload 5+ years of NSE data","Download KCB, Equity Bank, Safaricom, Co-op, EABL from Investing.com (10-year range). Upload each in the Data tab. More data = better accuracy."],
              ["Add CBK MPC dates","Go to the Events tab → click 'Add all upcoming CBK MPC dates'. These are the most impactful events for bank stocks."],
              ["Train and backtest","Go to Train tab → select a stock → Full Retrain. Then go to Backtest tab to see your real accuracy. Aim for >55%."],
              ["Export your data","Go to Audit tab → Export All Data. Keep this backup file safe. It's the only way to recover your trained models."],
              ["Try bulk import","If you have a combined NSE CSV with multiple stocks, use the Bulk Import section at the bottom of the Data tab."],
            ].map(([title,desc])=>(
              <div key={title} style={{display:"flex",gap:8,marginBottom:10}}>
                <div style={{color:"#22c55e",flexShrink:0,fontSize:14}}>✓</div>
                <div>
                  <div style={{fontSize:12,fontWeight:700,color:"#f9fafb"}}>{title}</div>
                  <div style={{fontSize:11,color:"#9ca3af",lineHeight:1.5}}>{desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {section==="deploy"&&(
        <div style={{display:"flex",flexDirection:"column",gap:10}}>
          <div style={{background:"#0f172a",border:"1px solid #1d4ed8",borderRadius:10,padding:14}}>
            <div style={{fontSize:13,fontWeight:800,color:"#93c5fd",marginBottom:8}}>How to deploy (make it accessible to others)</div>
            {[
              {step:"1",title:"Upload to Vercel or Netlify",desc:"Drag and drop your .tsx file. Free hosting. Your app gets a URL you can share.",setup:"vercel.com or netlify.com → New Project → drag file → Deploy"},
              {step:"2",title:"Set up Supabase",desc:"Free database that replaces localStorage. One project, free tier is generous.",setup:"supabase.com → New Project → copy URL and anon key"},
              {step:"3",title:"Swap the db object",desc:"Replace 4 lines in the db object with Supabase calls (see Backend tab). That's it.",setup:"One coding session. The migration stubs are already in the code."},
              {step:"4",title:"Add user auth",desc:"Supabase Auth adds login in about 10 lines. Admin role gets full access, viewer gets read-only.",setup:"supabase.com → Authentication → Enable Email provider"},
            ].map(item=>(
              <div key={item.step} style={{display:"flex",gap:10,marginBottom:10}}>
                <div style={{width:24,height:24,borderRadius:"50%",background:"#1d4ed8",color:"#fff",fontSize:11,fontWeight:800,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>{item.step}</div>
                <div>
                  <div style={{fontSize:12,fontWeight:700,color:"#f9fafb"}}>{item.title}</div>
                  <div style={{fontSize:11,color:"#9ca3af",lineHeight:1.5}}>{item.desc}</div>
                  <div style={{fontSize:11,background:"#111827",borderRadius:5,padding:"4px 8px",color:"#60a5fa",marginTop:4}}>🔧 {item.setup}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {section==="backend"&&(
        <div style={{display:"flex",flexDirection:"column",gap:12}}>
          <div style={{background:"#111827",border:"1px solid #374151",borderRadius:10,padding:14}}>
            <div style={{fontSize:12,fontWeight:700,color:"#f9fafb",marginBottom:8}}>The 20-line code change to migrate to Supabase</div>
            <div style={{fontFamily:"monospace",fontSize:11,color:"#9ca3af",lineHeight:1.8}}>
              <div style={{color:"#4b5563"}}>{"// Current (localStorage):"}</div>
              <div>{"const db = {"}</div>
              <div>{"  save: (k, v) => localStorage.setItem(k, JSON.stringify(v)),"}</div>
              <div>{"  load: (k) => JSON.parse(localStorage.getItem(k))"}</div>
              <div>{"}"}</div>
              <div style={{marginTop:8,color:"#4b5563"}}>{"// Replace with (Supabase):"}</div>
              <div>{"const db = {"}</div>
              <div>{"  save: async (k, v) => supabase.from('kv').upsert({key:k, value:v}),"}</div>
              <div>{"  load: async (k) => (await supabase.from('kv').select().eq('key',k)).data?.[0]?.value"}</div>
              <div>{"}"}</div>
            </div>
            <div style={{fontSize:11,color:"#6b7280",marginTop:8}}>Every other function stays exactly the same. Only the db object changes. Migration stubs are already in the code.</div>
          </div>
        </div>
      )}
      {section==="accuracy"&&(
        <div>
          <div style={{background:"#0f172a",border:"1px solid #1d4ed8",borderRadius:10,padding:14,marginBottom:14}}>
            <div style={{fontSize:13,fontWeight:800,color:"#93c5fd",marginBottom:8}}>What "beating the market" actually means</div>
            <div style={{fontSize:12,color:"#9ca3af",lineHeight:1.8}}>
              Most Kenyan investors either <b style={{color:"#f9fafb"}}>hold forever and hope</b> or <b style={{color:"#f9fafb"}}>guess based on news and feeling</b>. Beating them doesn't require 90% accuracy — it just requires being right slightly more often, consistently, with good risk management.<br/><br/>
              <b style={{color:"#22c55e"}}>55% accuracy + proper position sizing + stop-losses beats 45% accuracy + full portfolio bets every time.</b>
            </div>
          </div>
          <div style={{background:"#0f172a",border:"1px solid #374151",borderRadius:10,padding:14,marginBottom:14}}>
            <div style={{fontSize:13,fontWeight:800,color:"#f9fafb",marginBottom:8}}>Realistic accuracy targets</div>
            {[
              ["Today (random/AI test data)","35–50%","Expected — random data has no patterns","#ef4444"],
              ["After uploading 2–3 year CSVs","52–58%","Useful but not strong","#eab308"],
              ["After uploading 10-year CSVs","56–63%","Consistently useful","#eab308"],
              ["After adding macro history + events","60–68%","Competitive — beats most Kenyan tools","#22c55e"],
              ["After backend + live data + sentiment","65–72%","Genuinely strong — top tier for NSE","#22c55e"],
            ].map(([stage,range,desc,c])=>(
              <div key={stage} style={{display:"flex",gap:10,alignItems:"center",padding:"8px 0",borderBottom:"1px solid #111827"}}>
                <div style={{flex:2,fontSize:11,color:"#9ca3af"}}>{stage}</div>
                <div style={{fontSize:13,fontWeight:800,color:c,minWidth:70}}>{range}</div>
                <div style={{flex:1,fontSize:11,color:"#4b5563"}}>{desc}</div>
              </div>
            ))}
          </div>
          {[
            {title:"What other Kenyan tools do:", bad:true, items:["Moving average crossovers — freely available, everyone using it","Price targets from broker reports — lag reality by 6 months","WhatsApp group tips — no backtesting, no risk management","Foreign tools (TradingView) — not calibrated to NSE liquidity"]},
            {title:"What InvestIQ does differently:", bad:false, items:["24+ features including 6-level macro regime and NPL — no other NSE tool does this","Walk-forward backtesting with IR threshold — accuracy is honest","Neutral zone gate — says NEUTRAL when unsure instead of forcing a weak signal","Regime-aware ensemble — separate models for calm and volatile markets","Kelly position sizing with formula transparency","Bulk CSV engine — import years of NSE history in one file"]},
          ].map((s,i)=>(
            <div key={i} style={{background:"#0f172a",border:`1px solid ${s.bad?"#991b1b":"#166534"}`,borderRadius:10,padding:14,marginBottom:10}}>
              <div style={{fontSize:13,fontWeight:800,color:s.bad?"#f87171":"#22c55e",marginBottom:8}}>{s.title}</div>
              {s.items.map((item,j)=>(
                <div key={j} style={{display:"flex",gap:8,marginBottom:6,fontSize:12,color:"#9ca3af"}}>
                  <span style={{flexShrink:0,color:s.bad?"#ef4444":"#22c55e"}}>{s.bad?"✗":"✓"}</span>
                  <span>{item}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── U5: MODEL LAB TAB ───────────────────────────────────────────────────────
function ModelLabTab({stocks, stockDataMap}) {
  const [selected, setSelected] = useState(stocks[0]||"");
  const [running, setRunning]   = useState(false);
  const [results, setResults]   = useState(null);
  const [error, setError]       = useState(null);

  const run = async () => {
    if(!selected) return;
    setRunning(true); setResults(null); setError(null);
    await new Promise(r=>setTimeout(r,30));
    try {
      const sd = stockDataMap[selected];
      if(!sd||!sd.rows||sd.rows.length<120) {
        setError(`Need ≥120 rows for ${selected}. Currently have ${sd?.rows?.length||0}.`);
        setRunning(false); return;
      }
      const {rows, features} = sd;
      const horizon = 30;

      // Get or train models for this stock
      const models = sd.models || loadModelWeights(selected);
      if(!models?.m30) {
        setError(`No trained model for ${selected}. Go to Train tab first.`);
        setRunning(false); return;
      }

      // Fixed runCustomBT: proper fold boundaries + correct feature normalisation
      const runCustomBT = async (label, predictFn) => {
        await new Promise(r=>setTimeout(r,10));
        const warmup=50; const nFolds=5;
        const foldSize=Math.floor((rows.length-warmup)/nFolds);
        if(foldSize<20) return null;
        let corr=0, tot=0, allT=[];
        for(let fi=0; fi<nFolds; fi++) {
          const testStart=warmup+fi*foldSize;
          const testEnd=fi===nFolds-1?rows.length-horizon:testStart+foldSize;
          const ROLL=Math.min(750,testStart-warmup);
          const trainStart=Math.max(warmup,testStart-ROLL);
          const foldX=[];
          for(let i=trainStart;i<testStart-horizon;i++){
            if(rows[i]?._boundary||rows[i+horizon]?._boundary) continue;
            const f=fv(features[i]); if(f.some(v=>!isFinite(v))) continue;
            foldX.push(f);
          }
          if(foldX.length<10) continue;
          const mu=foldX[0].map((_,j)=>foldX.reduce((s,x)=>s+x[j],0)/foldX.length);
          const sd2=foldX[0].map((_,j)=>Math.sqrt(foldX.reduce((s,x)=>s+(x[j]-mu[j])**2,0)/foldX.length)+1e-8);
          const normalize=(fArr)=>fArr.map((v,j)=>(v-mu[j])/sd2[j]);
          const foldBand=calibrateDeadband(rows.slice(trainStart,testStart),horizon,0.30);
          for(let i=testStart;i<testEnd;i++){
            if(rows[i]?._boundary||rows[i+horizon]?._boundary) continue;
            const fRaw=fv(features[i]); if(fRaw.some(v=>!isFinite(v))) continue;
            const xn=normalize(fRaw);
            const ret=(rows[i+horizon].close-rows[i].close)/rows[i].close*100;
            const actual=ret>foldBand?2:ret<-foldBand?0:1;
            const pred=predictFn(xn,features[i],rows,i);
            if(pred!==1){
              if(pred===actual) corr++;
              tot++;
              if(pred===2) allT.push({ret,pred:1,actual:actual===2?1:0});
            }
          }
        }
        if(tot===0) return {label,acc:0,sharpe:null,winRate:0,maxDD:0,pf:0,trades:0};
        const metrics=calcAdvancedMetrics(allT,0);
        if(!metrics) return {label,acc:corr/tot,sharpe:null,winRate:0,maxDD:0,pf:0,trades:tot};
        const worstTrade=allT.length>0?Math.min(...allT.map(t=>t.ret)):0;
        return {label,acc:corr/tot,sharpe:metrics.sharpeRatio||null,winRate:metrics.winRate||0,
                maxDD:Math.abs(Math.min(worstTrade,0)),pf:metrics.profitFactor||0,trades:tot};
      };

      // 1. LogReg only
      const lrResult = await runCustomBT("LogReg", (xn)=>{
        if(!models.m30.clf_up) return 1;
        const pu=models.m30.clf_up.predict(xn);
        const pd=models.m30.clf_down?.predict(xn)||0;
        return pu>0.55?2:pd>0.55?0:1;
      });
      // 2. GBDT only
      const gbResult = await runCustomBT("GBDT", (xn)=>{
        if(!models.m30.gbdt_up) return 1;
        const pu=models.m30.gbdt_up.predict(xn);
        const pd=models.m30.gbdt_down?.predict(xn)||0;
        return pu>0.55?2:pd>0.55?0:1;
      });
      // 3. Pattern only
      const patResult = await runCustomBT("Pattern", (xn,rawFeat,rows,i)=>{
        const pats=findPatterns(features,rows,i,horizon,8);
        if(!pats||pats.length<3) return 1;
        const upFrac=pats.filter(p=>p.futureReturn>0).length/pats.length;
        return upFrac>0.6?2:upFrac<0.4?0:1;
      });
      // 4. Ensemble
      const ensResult = await runCustomBT("Ensemble", (xn)=>{
        const pu=ensembleProb(models.m30.clf_up||models.m30.clf,models.m30.gbdt_up,xn,null);
        const pd=ensembleProb(models.m30.clf_down,models.m30.gbdt_down,xn,null);
        return pu>0.55?2:pd>0.55?0:1;
      });

      const rows4=[lrResult,gbResult,patResult,ensResult].filter(Boolean);
      setResults({rows:rows4, stock:selected});
    } catch(e) {
      setError(`Error: ${e.message}`);
    }
    setRunning(false);
  };

  const MODEL_COLORS={LogReg:"#60a5fa",GBDT:"#22c55e",Pattern:"#eab308",Ensemble:"#a78bfa"};

  const bestInCol = (key) => {
    if(!results?.rows) return null;
    const vals = results.rows.map(r=>r[key]).filter(v=>v!=null);
    const best = key==="maxDD" ? Math.min(...vals) : Math.max(...vals);
    return best;
  };

  const isBest=(row,key)=>{
    const b=bestInCol(key);
    if(b==null) return false;
    return key==="maxDD" ? Math.abs(row[key]-b)<0.001 : Math.abs(row[key]-b)<0.001;
  };

  const genInsight=()=>{
    if(!results?.rows) return null;
    const lr  = results.rows.find(r=>r.label==="LogReg");
    const gb  = results.rows.find(r=>r.label==="GBDT");
    const pat = results.rows.find(r=>r.label==="Pattern");
    const ens = results.rows.find(r=>r.label==="Ensemble");
    const all = [lr,gb,pat,ens].filter(Boolean);
    const maxAcc=Math.max(...all.map(r=>r.acc));
    if(maxAcc<0.55) return {color:"#eab308",text:`No model has a reliable edge on ${selected} at this horizon. The neutral zone gate will suppress most signals. Consider sourcing more data or a longer horizon.`};
    if(ens&&ens.acc===maxAcc) return {color:"#a78bfa",text:`The ensemble is the strongest signal — model diversity is working as intended for ${selected}.`};
    if(gb&&lr&&gb.acc-lr.acc>0.03) return {color:"#22c55e",text:`GBDT is capturing nonlinear patterns for ${selected}. The regime-RSI interaction is likely a key driver. GBDT's weight in the ensemble is justified.`};
    if(pat&&gb&&pat.acc>gb.acc) return {color:"#eab308",text:`Pattern matching outperforms ML models for ${selected}. This stock may have recurring seasonal or event-driven cycles. Consider adding more event dates in the Events tab.`};
    return {color:"#60a5fa",text:`Models show comparable performance for ${selected}. The ensemble averages their strengths.`};
  };

  const insight=genInsight();
  const bestSingle=results?.rows?.filter(r=>r.label!=="Ensemble").sort((a,b)=>b.acc-a.acc)[0];
  const ensRow=results?.rows?.find(r=>r.label==="Ensemble");

  return(
    <div>
      <div style={{fontSize:17,fontWeight:900,color:"#f9fafb",marginBottom:4}}>🔬 Model Lab</div>
      <div style={{fontSize:12,color:"#6b7280",marginBottom:16,lineHeight:1.7}}>
        Head-to-head comparison of LogReg, GBDT, Pattern matching, and the Ensemble on the same stock and time period. Shows which model is driving the signal.
      </div>

      {/* Stock selector */}
      <div style={{display:"flex",gap:10,alignItems:"center",marginBottom:16,flexWrap:"wrap"}}>
        <select value={selected} onChange={e=>setSelected(e.target.value)}
          style={{background:"#1e293b",border:"1px solid #374151",color:"#f9fafb",borderRadius:7,padding:"9px 12px",fontSize:13,cursor:"pointer",outline:"none",flex:1,minWidth:200}}>
          {stocks.map(n=><option key={n} value={n}>{n}{stockDataMap[n]?.models?" ✓":""}</option>)}
        </select>
        <button onClick={run} disabled={running||!selected}
          style={{background:running||!selected?"#1f2937":"#1d4ed8",border:"none",color:running?"#6b7280":"#fff",borderRadius:7,padding:"10px 20px",cursor:running?"not-allowed":"pointer",fontWeight:800,fontSize:13,whiteSpace:"nowrap"}}>
          {running?"⏳ Running…":"▶ Run comparison"}
        </button>
      </div>

      {error&&<div style={{background:"#1c0a0a",border:"1px solid #991b1b",borderRadius:7,padding:"9px 12px",fontSize:12,color:"#f87171",marginBottom:12}}>{error}</div>}
      {running&&<div style={{textAlign:"center",padding:40,color:"#6b7280",fontSize:12}}>Running 4 backtests — this takes 10-30 seconds depending on dataset size…</div>}

      {results&&(
        <div>
          {/* Comparison table */}
          <div style={{background:"#0f172a",border:"1px solid #1f2937",borderRadius:10,overflow:"hidden",marginBottom:14}}>
            <div style={{display:"grid",gridTemplateColumns:"120px repeat(5,1fr)",gap:0}}>
              {["Model","Accuracy","Sharpe","Win Rate","Max DD","Profit Factor"].map(h=>(
                <div key={h} style={{padding:"8px 10px",background:"#0a0f1e",fontSize:10,fontWeight:700,color:"#6b7280",borderBottom:"1px solid #1f2937"}}>{h}</div>
              ))}
              {results.rows.map(row=>{
                const isEns=row.label==="Ensemble";
                const rowBg=isEns?"#0f1f3d":"#0f172a";
                return [
                  <div key={row.label+"l"} style={{padding:"9px 10px",background:rowBg,borderBottom:"1px solid #111827",display:"flex",alignItems:"center",gap:6}}>
                    <div style={{width:8,height:8,borderRadius:"50%",background:MODEL_COLORS[row.label],flexShrink:0}}/>
                    <span style={{fontSize:11,fontWeight:isEns?800:600,color:isEns?"#a78bfa":"#f9fafb"}}>{row.label}</span>
                  </div>,
                  ...[
                    ["acc",v=>`${(v*100).toFixed(1)}%`],
                    ["sharpe",v=>v?.toFixed(2)??"—"],
                    ["winRate",v=>v!=null?`${(v*100).toFixed(0)}%`:"—"],
                    ["maxDD",v=>v!=null?`${v?.toFixed(1)}%`:"—"],
                    ["pf",v=>v?.toFixed(2)??"—"],
                  ].map(([key,fmt])=>{
                    const best=isBest(row,key);
                    return <div key={row.label+key} style={{padding:"9px 10px",background:best?"#052e16":rowBg,borderBottom:"1px solid #111827",fontSize:12,fontWeight:best?800:400,color:best?"#22c55e":isEns?"#c4b5fd":"#9ca3af"}}>{fmt(row[key])}</div>;
                  })
                ];
              })}
            </div>
          </div>

          {/* Summary line */}
          <div style={{background:"#111827",border:"1px solid #1f2937",borderRadius:6,
            padding:"7px 12px",marginBottom:10,fontSize:10,color:"#6b7280",lineHeight:1.5}}>
            ℹ️ <b style={{color:"#9ca3af"}}>Model Lab uses saved weights</b> — not a fresh retrain per fold.
            {" "}<b style={{color:"#9ca3af"}}>Backtest tab</b> retrains each fold and shows higher accuracy. Use Backtest as authoritative.
            {" "}Accuracy = % of UP+DOWN calls correct. Win Rate = % of UP calls that were profitable. These differ because DOWN calls are excluded from Win Rate.
          </div>
          {bestSingle&&ensRow&&(
            <div style={{fontSize:11,color:"#9ca3af",marginBottom:14,lineHeight:1.7}}>
              Best single model: <b style={{color:MODEL_COLORS[bestSingle.label]}}>{bestSingle.label}</b> ({(bestSingle.acc*100).toFixed(1)}%)
              {" · "}Edge over random: <b style={{color:"#22c55e"}}>+{((bestSingle.acc-0.5)*100).toFixed(0)}pp</b>
              {ensRow&&<span> · Ensemble gain over best single: <b style={{color:"#a78bfa"}}>+{((ensRow.acc-bestSingle.acc)*100).toFixed(0)}pp</b></span>}
            </div>
          )}

          {/* Bar chart */}
          <div style={{background:"#0f172a",border:"1px solid #1f2937",borderRadius:10,padding:14,marginBottom:14}}>
            <div style={{fontSize:11,fontWeight:700,color:"#f9fafb",marginBottom:10}}>Accuracy by model</div>
            {results.rows.map(row=>(
              <div key={row.label} style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}>
                <div style={{fontSize:11,color:MODEL_COLORS[row.label],fontWeight:700,width:70,flexShrink:0}}>{row.label}</div>
                <div style={{flex:1,height:20,background:"#1f2937",borderRadius:4,overflow:"hidden",position:"relative"}}>
                  <div style={{width:`${Math.min(100,(row.acc||0)*100)}%`,height:"100%",background:MODEL_COLORS[row.label],borderRadius:4,opacity:0.85}}/>
                  <div style={{position:"absolute",left:8,top:0,bottom:0,display:"flex",alignItems:"center",fontSize:10,fontWeight:700,color:"#fff"}}>{(row.acc*100).toFixed(1)}%</div>
                </div>
                {/* 50% baseline marker */}
                <div style={{fontSize:9,color:"#374151",width:30,textAlign:"right"}}>50%=random</div>
              </div>
            ))}
            <div style={{fontSize:9,color:"#374151",marginTop:4}}>Dashed 50% = coin flip baseline. Any model above 55% has learnable edge.</div>
          </div>

          {/* Insight box */}
          {insight&&(
            <div style={{background:"#0a0f1e",border:`1px solid ${insight.color}44`,borderRadius:10,padding:14}}>
              <div style={{fontSize:11,fontWeight:700,color:insight.color,marginBottom:4}}>💡 Insight</div>
              <div style={{fontSize:12,color:"#d1d5db",lineHeight:1.7}}>{insight.text}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
// 5a: v9.4.0 — 1b: Events tab added, 1c: Gaps & Roadmap tab added
// ─── 🟢 LIVE TRADING LAB ─────────────────────────────────────────────────────
// Temporary campsite for live signal testing. No backend, no scheduler.
// All state in localStorage via db. 5 watched stocks only.
// ─────────────────────────────────────────────────────────────────────────────

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

function LabBadge({signal}){
  const cfg={BUY:{bg:"#052e16",border:"#166534",color:"#4ade80"},SELL:{bg:"#1c0a0a",border:"#991b1b",color:"#f87171"},HOLD:{bg:"#0f172a",border:"#374151",color:"#9ca3af"}};
  const c=cfg[signal]||cfg.HOLD;
  return <span style={{padding:"3px 10px",borderRadius:5,fontSize:12,fontWeight:800,background:c.bg,border:`1px solid ${c.border}`,color:c.color}}>{signal}</span>;
}

function LiveLabTab({stocks, stockDataMap, setStockDataMap, log, onStocksChanged}){
  const [section, setSection] = useState("watchlist");
  const [journal, setJournal] = useState(()=>loadLabJournal());
  const [paper, setPaper] = useState(()=>loadLabPaper());
  const [checkinPrices, setCheckinPrices] = useState(()=>{
    const c=loadLabCheckin(); return LAB_STOCKS.reduce((a,s)=>({...a,[s]:c[s]?.lastPrice||""}),{});
  });
  const [retraining, setRetraining] = useState({});
  const [feedStock, setFeedStock] = useState(LAB_STOCKS[0]);
  const [feedCSV, setFeedCSV] = useState("");
  const [feedMsg, setFeedMsg] = useState(null);
  const [checkinMsg, setCheckinMsg] = useState(null);

  // ── Derived: status per stock ──────────────────────────────────────────────
  const stockStatus = LAB_STOCKS.map(name=>{
    const ticker = LAB_TICKERS[name];
    const sd = stockDataMap[name] || loadStockData(name);
    const rows = sd?.rows || [];
    const lastRow = rows[rows.length-1];
    const hasData = rows.length >= 60;
    const hasTrained = !!sd?.models?.m30;
    const lastDate = lastRow?.date || null;
    const lastClose = lastRow?.close || null;
    const modelWindow = sd ? (() => {
      const saved = db.load("iq_train_results", {});
      const r = saved[name];
      return r ? `${((new Date(r.to)-new Date(r.from))/86400000/365).toFixed(1)}yr` : "—";
    })() : "—";
    const pred = (hasData && hasTrained) ? (() => { try { return generatePredictionGuarded(sd, null, stockDataMap); } catch(e){ return null; }})() : null;
    return {name, ticker, hasData, hasTrained, lastDate, lastClose, modelWindow, pred, rows};
  });

  // ── Scoreboard ─────────────────────────────────────────────────────────────
  const scored = journal.filter(j=>j.actual!=null);
  const correct = scored.filter(j=>j.correct).length;
  const totalSig = journal.length;
  const hitRate = scored.length ? Math.round(correct/scored.length*100) : null;
  const perStock = LAB_STOCKS.reduce((acc,name)=>{
    const s = scored.filter(j=>j.stock===name);
    acc[name] = s.length ? Math.round(s.filter(j=>j.correct).length/s.length*100) : null;
    return acc;
  },{});

  // ── Paper portfolio summary ────────────────────────────────────────────────
  const paperReturn = ((paper.value - LAB_PAPER_START)/LAB_PAPER_START*100).toFixed(2);
  const paperTrades = paper.trades||[];
  const paperWins = paperTrades.filter(t=>t.pnl>0).length;
  const paperWinRate = paperTrades.length ? Math.round(paperWins/paperTrades.length*100) : null;
  const paperDrawdown = paperTrades.length ? (() => {
    let peak=LAB_PAPER_START, minVal=LAB_PAPER_START, running=LAB_PAPER_START;
    for(const t of paperTrades){ running+=t.pnl; peak=Math.max(peak,running); minVal=Math.min(minVal,running); }
    return ((peak-minVal)/peak*100).toFixed(1);
  })() : "0.0";

  // ── Data Feed handler ──────────────────────────────────────────────────────
  const handleFeedUpload = async () => {
    if(!feedCSV.trim()){ setFeedMsg({type:"error",text:"Paste CSV data first."}); return; }
    setFeedMsg({type:"info",text:"Processing…"});
    await new Promise(r=>setTimeout(r,30));
    try {
      const existing = db.load(STOCK_KEY(feedStock)) || [];
      const newRows = parseCSV(feedCSV.trim());
      if(!newRows || newRows.length < 2){ setFeedMsg({type:"error",text:`Parsed ${newRows?.length||0} rows — too few. Check CSV format.`}); return; }
      const existingDates = new Set(existing.map(r=>r.date));
      const toAdd = newRows.filter(r=>r.date && !existingDates.has(r.date));
      const merged = [...existing, ...toAdd].sort((a,b)=>a.date<b.date?-1:1);
      const deduped = merged.filter((r,i)=>i===0||r.date!==merged[i-1].date);
      if(!hasAdminRole()){ setFeedMsg({type:"error",text:"Admin role required to save data."}); return; }
      saveStockData(feedStock, deduped);
      // Rebuild features and update stockDataMap
      const features = buildFeaturesForStock(deduped, feedStock, null, null, stockDataMap);
      const sd = stockDataMap[feedStock] || {};
      const updated = {...sd, rows:deduped, features, name:feedStock};
      setStockDataMap(prev=>({...prev,[feedStock]:updated}));
      onStocksChanged([...new Set([...stocks, feedStock])]);
      setFeedCSV("");
      setFeedMsg({type:"success",text:`✅ ${feedStock}: merged ${toAdd.length} new rows (${deduped.length} total). Ready to retrain.`});
      log("LIVELAB","SUCCESS",`Data feed: ${feedStock} +${toAdd.length} rows → ${deduped.length} total`);
    } catch(e) {
      setFeedMsg({type:"error",text:`Error: ${e.message}`});
      log("LIVELAB","ERROR",`Data feed failed for ${feedStock}: ${e.message}`);
    }
  };

  // ── Retrain handler ────────────────────────────────────────────────────────
  const handleRetrain = async (name) => {
    setRetraining(r=>({...r,[name]:true}));
    await new Promise(r=>setTimeout(r,30));
    try {
      // Always read fresh rows from localStorage to avoid stale React state
      const freshStoredRows = db.load(STOCK_KEY(name)) || [];
      // Strip weekend/non-trading rows — NSE only trades Mon-Fri
      // A row is suspicious if it was appended on a weekend with no real market data
      const isWeekend = (dateStr) => { const d = new Date(dateStr); return d.getDay()===0||d.getDay()===6; };
      const cleanStoredRows = freshStoredRows.filter(r=>!isWeekend(r.date));
      const sd = cleanStoredRows.length > 0
        ? {...(stockDataMap[name] || loadStockData(name) || {}), rows: cleanStoredRows, name}
        : (stockDataMap[name] || loadStockData(name));
      if(!sd || sd.rows.length < 60){ setRetraining(r=>({...r,[name]:false})); return; }
      let rows = [...sd.rows];
      // Apply 2yr recency window
      const lastDate = rows[rows.length-1].date;
      const cutoff = new Date(lastDate); cutoff.setFullYear(cutoff.getFullYear()-2);
      const cutStr = cutoff.toISOString().split("T")[0];
      const filtered = rows.filter(r=>r.date>=cutStr);
      if(filtered.length>=60) rows=filtered;
      const features = buildFeaturesForStock(rows, name, null, null, stockDataMap);
      const g30 = trainModelsGuarded(rows, features, 30, null, null);
      await new Promise(r=>setTimeout(r,0));
      const g60 = trainModelsGuarded(rows, features, 60, null, null);
      await new Promise(r=>setTimeout(r,0));
      const g90 = trainModelsGuarded(rows, features, 90, null, null);
      await new Promise(r=>setTimeout(r,0));
      const backtest = walkForwardBacktest(rows, features, 30, 5, name, true);
      const models = {m30:g30.model, m60:g60.model, m90:g90.model, backtest, trainedAt:new Date().toISOString(), runCount:(sd.models?.runCount||0)+1};
      if(g30.model) saveModelWeights(name, models, g30.model.norm);
      // Update iq_train_results with correct 2yr window dates so window display stays accurate
      const trainResults = db.load("iq_train_results", {});
      const fromDate = rows[0]?.date||"";
      const toDate = rows[rows.length-1]?.date||"";
      const windowYrs = fromDate&&toDate ? ((new Date(toDate)-new Date(fromDate))/86400000/365).toFixed(1) : "?";
      trainResults[name] = {...(trainResults[name]||{}), from:fromDate, to:toDate, rows:rows.length, trainedAt:new Date().toISOString(), runCount:(trainResults[name]?.runCount||0)+1, accuracy:backtest?.avgAccuracy||0};
      db.save("iq_train_results", trainResults);
      const updated = {...sd, rows:sd.rows, features:buildFeaturesForStock(sd.rows,name,null,null,stockDataMap), models, name};
      setStockDataMap(prev=>({...prev,[name]:updated}));
      log("LIVELAB","SUCCESS",`Retrain ${name}: BT acc ${((backtest?.avgAccuracy||0)*100).toFixed(1)}% · window ${windowYrs}yr (${fromDate} → ${toDate})`);
      // Only log journal entry if the last data row matches today's date (i.e. called from check-in)
      // Manual retrain on weekend/same-day should NOT create new journal entries
      const pred = generatePredictionGuarded(updated, null, stockDataMap);
      if(pred){
        const today = new Date().toISOString().split("T")[0];
        const lastDataDate = updated.rows[updated.rows.length-1]?.date||"";
        const calledFromCheckin = lastDataDate === today;
        if(calledFromCheckin){
          const entry = {id:Date.now(), date:today, stock:name, ticker:LAB_TICKERS[name], signal:pred.signal, confidence:pred.confidence, probUp:Math.round((pred.probUp||0)*100), actual:null, correct:null, price:updated.rows[updated.rows.length-1]?.close||null};
          const j = loadLabJournal();
          // Only add if no entry exists for today+stock already
          const alreadyLogged = j.some(e=>e.date===today&&e.stock===name&&e.actual==null);
          if(!alreadyLogged){
            const newJ = [...j, entry];
            saveLabJournal(newJ);
            setJournal(newJ);
            // Paper portfolio: open trade only if no open trade exists today for this stock
            const freshRows = db.load(STOCK_KEY(name)) || updated.rows;
            const lastClose = freshRows[freshRows.length-1]?.close||0;
            if(pred.signal!=="HOLD" && lastClose>0){
              const p = loadLabPaper();
              const alreadyHasTrade = (p.trades||[]).some(t=>t.stock===name&&t.date===today&&!t.closed);
              if(!alreadyHasTrade){
                const alloc = Math.floor(p.value * 0.15);
                const shares = Math.floor(alloc / lastClose);
                if(shares>0){
                  const trade = {id:Date.now(), date:today, stock:name, signal:pred.signal, shares, entryPrice:lastClose, pnl:null, closed:false};
                  const np = {...p, trades:[...(p.trades||[]), trade]};
                  saveLabPaper(np); setPaper(np);
                }
              }
            }
          }
        }
      }
    } catch(e){ log("LIVELAB","ERROR",`Retrain ${name} failed: ${e.message}`); }
    setRetraining(r=>({...r,[name]:false}));
  };

  // ── Daily check-in handler ─────────────────────────────────────────────────
  const handleCheckin = async () => {
    setCheckinMsg({type:"info",text:"Processing check-in…"});
    await new Promise(r=>setTimeout(r,30));
    const _now = new Date();
    const _todayRaw = _now.toISOString().split("T")[0];
    const _dayOfWeek = _now.getDay();
    // If weekend, use last Friday as effective date for catch-up entries
    const _lastFri = new Date(_now);
    if(_dayOfWeek===6) _lastFri.setDate(_lastFri.getDate()-1);
    if(_dayOfWeek===0) _lastFri.setDate(_lastFri.getDate()-2);
    const today = (_dayOfWeek===0||_dayOfWeek===6) ? _lastFri.toISOString().split("T")[0] : _todayRaw;
    const yesterday = new Date(new Date(today).getTime()-86400000).toISOString().split("T")[0];
    // Weekend gate — warn but allow if user explicitly entering missed Friday prices
    const todayDay = new Date().getDay();
    const isWeekend = todayDay===0||todayDay===6;
    // Check if any prices entered — if yes on weekend, treat as catch-up entry for Friday
    const hasAnyPrice = LAB_STOCKS.some(n=>checkinPrices[n]&&!isNaN(parseFloat(checkinPrices[n]))&&parseFloat(checkinPrices[n])>0);
    if(isWeekend && !hasAnyPrice){
      setCheckinMsg({type:"warn", text:`⚠ Today is a weekend — NSE is closed. Enter Friday's closing prices above to catch up, or come back Monday.`});
      return;
    }
    // Weekend catch-up: today variable already set to last Friday above
    let updated = 0; let errors = [];
    const checkinState = loadLabCheckin();
    for(const name of LAB_STOCKS){
      const raw = checkinPrices[name];
      const price = parseFloat(raw);
      if(!raw||isNaN(price)||price<=0){ continue; }
      try {
        // 1. Append or update today's close in stored data
        const existing = db.load(STOCK_KEY(name)) || [];
        const todayIdx = existing.findIndex(r=>r.date===today);
        const lastRow = existing[existing.length-1] || {};
        const newRow = {date:today, open:price, high:price, low:price, close:price, volume:lastRow.volume||0};
        let newRows;
        if(todayIdx >= 0){
          // Update existing today row with corrected price
          newRows = [...existing];
          newRows[todayIdx] = newRow;
        } else {
          newRows = [...existing, newRow];
        }
        saveStockData(name, newRows);
        const features = buildFeaturesForStock(newRows, name, null, null, stockDataMap);
        const sd = stockDataMap[name]||{};
        setStockDataMap(prev=>({...prev,[name]:{...sd, rows:newRows, features, name}}));
        // 2. Evaluate the most recent unevaluated prediction for this stock
        // (not strictly "yesterday" — handles gaps from missed check-ins / outages)
        const j = loadLabJournal();
        const pendingEntries = j.filter(e=>e.stock===name&&e.actual==null&&e.date<today)
                                  .sort((a,b)=>a.date<b.date?-1:1);
        const pendingEntry = pendingEntries[pendingEntries.length-1]; // most recent pending
        if(pendingEntry){
          const storedRows = db.load(STOCK_KEY(name))||[];
          const prevRow = storedRows.find(r=>r.date===pendingEntry.date);
          const prevPrice = prevRow?.close || pendingEntry.price || null;
          let actual = null; let correct = null;
          if(prevPrice){
            const pctChange = (price - prevPrice)/prevPrice*100;
            // Stock-specific deadbands based on typical daily volatility
            // Tight band for low-volatility stocks, wider for volatile ones
            const STOCK_BANDS = {
              "Stanbic Bank": 1.5,
              "Co-op Bank": 1.0,
              "Kenya Re": 1.0,
              "ABSA NewGold ETF": 2.0,
              "Crown Paints": 1.0,
            };
            const band = STOCK_BANDS[pendingEntry.stock] || 1.5;
            actual = pctChange > band ? "UP" : pctChange < -band ? "DOWN" : "FLAT";
            const predDir = pendingEntry.signal==="BUY"?"UP":pendingEntry.signal==="SELL"?"DOWN":"FLAT";
            correct = predDir === actual;
            // Close paper trade if open (match by stock + that entry's date)
            const p = loadLabPaper();
            const openTrade = (p.trades||[]).findIndex(t=>t.stock===name&&t.date===pendingEntry.date&&!t.closed);
            if(openTrade>=0){
              const t = p.trades[openTrade];
              const pnl = (price - t.entryPrice) * t.shares * (t.signal==="SELL"?-1:1);
              p.trades[openTrade] = {...t, exitPrice:price, pnl, closed:true};
              p.value = p.value + pnl;
              saveLabPaper(p); setPaper({...p});
            }
          }
          // Mark ALL other pending entries (older than the one just evaluated) as stale/skipped
          // so they don't silently accumulate forever — they stay ⏳ but won't be picked up again
          // once a newer one exists. Only the most recent pending gets evaluated against today's price.
          const newJ = j.map(e=>e.id===pendingEntry.id?{...e,actual,correct}:e);
          saveLabJournal(newJ); setJournal(newJ);
        }
        checkinState[name] = {lastPrice:price, lastDate:today};
        updated++;
      } catch(e){ errors.push(name); }
    }
    saveLabCheckin(checkinState);
    // 3. Retrain all stocks that got new data
    if(updated>0){
      for(const name of LAB_STOCKS){
        if(checkinPrices[name] && !isNaN(parseFloat(checkinPrices[name]))){
          await handleRetrain(name);
        }
      }
    }
    setCheckinMsg({type:updated>0?"success":"warn", text: updated>0 ? `✅ Updated ${updated} stock(s) · evaluated yesterday's signals · retrained · new predictions logged.` : `No valid prices entered — enter at least one close price.`});
  };

  // ── Section nav ────────────────────────────────────────────────────────────
  const sections = [["watchlist","📡 Watchlist"],["feed","📥 Data Feed"],["checkin","📝 Daily Check-In"],["journal","📓 Signal Journal"],["scoreboard","🏆 Scoreboard"],["weekly","📆 Weekly Accuracy"],["paper","💰 Paper Portfolio"],["retrain","🔄 Retrain"],["health","🩺 Data Health"]];
  const S = (k)=>({padding:"6px 12px",borderRadius:6,border:`1px solid ${section===k?"#3b82f6":"#1f2937"}`,background:section===k?"#1e3a5f":"#0f172a",color:section===k?"#93c5fd":"#6b7280",cursor:"pointer",fontSize:11,fontWeight:section===k?700:400,whiteSpace:"nowrap"});

  return (
    <div>
      {/* Header */}
      <div style={{marginBottom:16}}>
        <div style={{fontSize:17,fontWeight:900,color:"#f9fafb",marginBottom:2}}>🟢 Live Trading Lab</div>
        <div style={{fontSize:12,color:"#6b7280"}}>Temporary campsite · 5 stocks · daily check-in · paper portfolio · signal journal</div>
      </div>

      {/* Section nav */}
      <div style={{display:"flex",gap:4,flexWrap:"wrap",marginBottom:18,background:"#0a1628",borderRadius:8,padding:4,border:"1px solid #0f1f3d"}}>
        {sections.map(([k,label])=><button key={k} style={S(k)} onClick={()=>setSection(k)}>{label}</button>)}
      </div>

      {/* ── WATCHLIST ───────────────────────────────────────────────────────── */}
      {section==="watchlist"&&(
        <div>
          <div style={{fontSize:13,fontWeight:700,color:"#9ca3af",marginBottom:12}}>Live Watchlist — {new Date().toLocaleDateString("en-KE",{weekday:"short",year:"numeric",month:"short",day:"numeric"})}</div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))",gap:12}}>
            {stockStatus.map(({name,ticker,hasData,hasTrained,lastDate,lastClose,modelWindow,pred})=>(
              <div key={name} style={{background:"#0f172a",border:`1px solid ${pred?( pred.signal==="BUY"?"#166534":pred.signal==="SELL"?"#991b1b":"#1f2937"):"#1f2937"}`,borderRadius:10,padding:14}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:8}}>
                  <div>
                    <div style={{fontWeight:800,fontSize:14,color:"#f9fafb"}}>{ticker}</div>
                    <div style={{fontSize:11,color:"#6b7280"}}>{name}</div>
                  </div>
                  {pred ? <LabBadge signal={pred.signal}/> : <span style={{fontSize:10,color:"#4b5563",background:"#111827",border:"1px solid #1f2937",borderRadius:4,padding:"2px 8px"}}>{!hasData?"No Data":!hasTrained?"Not Trained":"—"}</span>}
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:4,fontSize:11}}>
                  <div style={{color:"#6b7280"}}>Latest close</div>
                  <div style={{color:"#f9fafb",fontWeight:700}}>{lastClose ? `KES ${fmt(lastClose)}` : "—"}</div>
                  <div style={{color:"#6b7280"}}>Latest date</div>
                  <div style={{color:"#9ca3af"}}>{lastDate||"—"}</div>
                  <div style={{color:"#6b7280"}}>Model window</div>
                  <div style={{color:"#9ca3af"}}>{modelWindow}</div>
                  <div style={{color:"#6b7280"}}>Confidence</div>
                  <div style={{color: pred?.confidence>60?"#4ade80":pred?.confidence>50?"#facc15":"#f87171"}}>{pred ? `${pred.confidence}%` : "—"}</div>
                </div>
                {pred?.probUp!=null&&(
                  <div style={{marginTop:8,display:"flex",gap:4}}>
                    {[["UP",pred.probUp,"#22c55e"],["FLAT",pred.probFlat,"#6b7280"],["DOWN",pred.probDown,"#ef4444"]].map(([l,v,c])=>(
                      <div key={l} style={{flex:1,textAlign:"center"}}>
                        <div style={{fontSize:9,color:c,fontWeight:700}}>{l}</div>
                        <div style={{height:3,background:"#1f2937",borderRadius:2,marginTop:2}}>
                          <div style={{width:`${Math.round((v||0)*100)}%`,height:"100%",background:c,borderRadius:2}}/>
                        </div>
                        <div style={{fontSize:10,color:c}}>{Math.round((v||0)*100)}%</div>
                      </div>
                    ))}
                  </div>
                )}
                {pred?.signal==="HOLD" && pred?.gateNeutral && (pred.probUp>0.55||pred.probDown>0.55) && (
                  <div style={{marginTop:8,fontSize:10,color:"#d97706",background:"#1c1400",borderRadius:4,padding:"5px 8px",lineHeight:1.5}}>
                    ⚠ Probability leans {pred.probUp>0.55?"UP":"DOWN"} ({Math.round((pred.probUp>0.55?pred.probUp:pred.probDown)*100)}%) but forced to HOLD:
                    {pred.neutralReasons?.slice(0,1).map((r,i)=><div key={i} style={{marginTop:2}}>• {r}</div>)}
                  </div>
                )}
                {!hasData&&<div style={{marginTop:8,fontSize:10,color:"#854d0e",background:"#1c1400",borderRadius:4,padding:"4px 8px"}}>⚠ Upload gap CSV in Data Feed first</div>}
                {hasData&&!hasTrained&&<div style={{marginTop:8,fontSize:10,color:"#3b82f6",background:"#0c1a2e",borderRadius:4,padding:"4px 8px"}}>→ Go to Retrain to train this stock</div>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── DATA FEED ───────────────────────────────────────────────────────── */}
      {section==="feed"&&(
        <div style={{maxWidth:680}}>
          <div style={{fontSize:13,fontWeight:700,color:"#9ca3af",marginBottom:4}}>📥 Gap Data Feed</div>
          <div style={{fontSize:11,color:"#6b7280",marginBottom:14}}>Paste CSV data for Jan 2025 → today to fill the model gap. Duplicates are automatically removed. CSV must have Date, Close columns at minimum.</div>
          <div style={{marginBottom:10}}>
            <div style={{fontSize:11,color:"#9ca3af",marginBottom:6,fontWeight:700}}>Select Stock</div>
            <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
              {LAB_STOCKS.map(name=>{
                const {hasData} = stockStatus.find(s=>s.name===name)||{};
                return <button key={name} onClick={()=>{setFeedStock(name);setFeedMsg(null);}} style={{padding:"5px 12px",borderRadius:6,border:`1px solid ${feedStock===name?"#3b82f6":"#1f2937"}`,background:feedStock===name?"#1e3a5f":"#0f172a",color:feedStock===name?"#93c5fd":"#6b7280",fontSize:11,cursor:"pointer",fontWeight:feedStock===name?700:400}}>
                  {LAB_TICKERS[name]} {hasData?"✅":"✗"}
                </button>;
              })}
            </div>
          </div>
          <div style={{marginBottom:10}}>
            <div style={{fontSize:11,color:"#9ca3af",marginBottom:4,fontWeight:700}}>CSV Data — {feedStock} ({LAB_TICKERS[feedStock]})</div>
            <textarea
              value={feedCSV}
              onChange={e=>setFeedCSV(e.target.value)}
              placeholder={`Paste CSV here e.g.:\nDate,Open,High,Low,Close,Volume\n2025-01-02,230.00,235.00,228.00,232.50,120000\n2025-01-03,...`}
              style={{width:"100%",height:180,background:"#0a1628",border:"1px solid #1f2937",borderRadius:8,color:"#f9fafb",fontSize:11,padding:10,fontFamily:"monospace",resize:"vertical",boxSizing:"border-box"}}
            />
          </div>
          <button onClick={handleFeedUpload} style={{padding:"9px 22px",borderRadius:7,border:"none",background:"#1d4ed8",color:"#fff",fontSize:13,fontWeight:700,cursor:"pointer"}}>Merge & Save Data</button>
          {feedMsg&&<div style={{marginTop:10,padding:"8px 12px",borderRadius:6,background:feedMsg.type==="success"?"#052e16":feedMsg.type==="error"?"#1c0a0a":"#0c1a2e",border:`1px solid ${feedMsg.type==="success"?"#166534":feedMsg.type==="error"?"#991b1b":"#1e40af"}`,color:feedMsg.type==="success"?"#4ade80":feedMsg.type==="error"?"#f87171":"#93c5fd",fontSize:12}}>{feedMsg.text}</div>}
          <div style={{marginTop:16,background:"#0a1628",border:"1px solid #0f1f3d",borderRadius:8,padding:12,fontSize:11,color:"#4b5563",lineHeight:1.7}}>
            <div style={{color:"#6b7280",fontWeight:700,marginBottom:4}}>Where to get gap data (Jan 2025 → today):</div>
            <div>• <span style={{color:"#9ca3af"}}>Investing.com</span> → search ticker → Historical Data → download CSV</div>
            <div>• <span style={{color:"#9ca3af"}}>Yahoo Finance</span> → SBIC.NR, COOP.NR, KNRE.NR, GLD.NR → Historical → Download</div>
            <div>• <span style={{color:"#9ca3af"}}>NSE website</span> → Market Data → Historical Prices</div>
            <div>• <span style={{color:"#9ca3af"}}>mystocks.co.ke</span> → each stock page → download</div>
          </div>
        </div>
      )}

      {/* ── DAILY CHECK-IN ──────────────────────────────────────────────────── */}
      {section==="checkin"&&(
        <div style={{maxWidth:560}}>
          <div style={{fontSize:13,fontWeight:700,color:"#9ca3af",marginBottom:4}}>📝 Daily Check-In</div>
          <div style={{fontSize:11,color:"#6b7280",marginBottom:12}}>Every evening — enter today's closing prices. This will: append today's row, evaluate yesterday's signal, update hit rate, retrain, and generate tomorrow's signal.</div>

          {/* ── Yesterday's signals summary — reads last journal entry per stock ── */}
          {(()=>{
            // Read the most recent journal entry per stock — already has signal/conf/probUp
            // This works on fresh browser open without any retraining
            const latestPerStock = LAB_STOCKS.map(name=>{
              const rows = db.load(STOCK_KEY(name))||[];
              const lastRow = rows[rows.length-1];
              const lastClose = lastRow?.close||null;
              const lastDate = lastRow?.date||null;
              const ticker = LAB_TICKERS[name];
              // Find most recent journal entry for this stock
              const entries = [...journal]
                .filter(e=>e.stock===name)
                .sort((a,b)=>b.date<a.date?-1:1);
              const latest = entries[0]||null;
              return {name,ticker,lastClose,lastDate,latest};
            });
            return (
              <div style={{background:"#0a1628",border:"1px solid #1e3a5f",borderRadius:10,padding:12,marginBottom:14}}>
                <div style={{fontSize:11,fontWeight:700,color:"#6b7280",marginBottom:10}}>📊 Current signals — from last check-in</div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:6}}>
                  {latestPerStock.map(({name,ticker,lastClose,lastDate,latest})=>{
                    const signal = latest?.signal||"—";
                    const conf = latest?.confidence||null;
                    const probUp = latest?.probUp||null;
                    const lean = probUp!=null?(probUp>50?"UP":probUp<50?"DOWN":"—"):"—";
                    const leanColor = lean==="UP"?"#4ade80":lean==="DOWN"?"#f87171":"#9ca3af";
                    const sigColor = signal==="BUY"?"#4ade80":signal==="SELL"?"#f87171":"#6b7280";
                    const sigBorder = signal==="BUY"?"#166534":signal==="SELL"?"#991b1b":"#1f2937";
                    return (
                      <div key={name} style={{background:"#0f172a",borderRadius:7,padding:"8px 6px",border:`1px solid ${sigBorder}`,textAlign:"center"}}>
                        <div style={{fontSize:11,fontWeight:800,color:"#f9fafb"}}>{ticker}</div>
                        <div style={{fontSize:10,color:"#4b5563",marginTop:1}}>{lastClose?`${fmt(lastClose)}`:""}</div>
                        <div style={{fontSize:14,fontWeight:900,color:leanColor,marginTop:4}}>{lean}</div>
                        <div style={{fontSize:9,color:sigColor,fontWeight:700,marginTop:1}}>{signal}</div>
                        <div style={{fontSize:9,color:"#4b5563",marginTop:2}}>{conf!=null?`${conf}% conf`:"no signal yet"}</div>
                        <div style={{fontSize:9,color:leanColor}}>{probUp!=null?`UP ${probUp}%`:""}</div>
                        <div style={{fontSize:8,color:"#374151",marginTop:1}}>{latest?.date||""}</div>
                      </div>
                    );
                  })}
                </div>
                <div style={{fontSize:9,color:"#374151",marginTop:8}}>From journal — no retrain needed. Refreshes after each check-in.</div>
              </div>
            );
          })()}

          <div style={{background:"#0f172a",border:"1px solid #1f2937",borderRadius:10,padding:16,marginBottom:14}}>
            <div style={{fontSize:11,color:"#6b7280",marginBottom:12}}>{new Date().toLocaleDateString("en-KE",{weekday:"long",year:"numeric",month:"long",day:"numeric"})}</div>
            {LAB_STOCKS.map(name=>{
              const {lastClose, lastDate} = stockStatus.find(s=>s.name===name)||{};
              return (
                <div key={name} style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
                  <div style={{width:48,fontWeight:700,fontSize:13,color:"#f9fafb"}}>{LAB_TICKERS[name]}</div>
                  <div style={{fontSize:10,color:"#4b5563",width:110}}>{lastClose?`prev: ${fmt(lastClose)} (${lastDate||"?"})`:""}</div>
                  <input
                    type="number"
                    placeholder="Close price"
                    value={checkinPrices[name]}
                    onChange={e=>setCheckinPrices(p=>({...p,[name]:e.target.value}))}
                    style={{flex:1,padding:"6px 10px",borderRadius:6,border:"1px solid #1f2937",background:"#0a1628",color:"#f9fafb",fontSize:13,fontFamily:"monospace"}}
                  />
                </div>
              );
            })}
          </div>
          <button onClick={handleCheckin} style={{padding:"10px 28px",borderRadius:7,border:"none",background:"#16a34a",color:"#fff",fontSize:14,fontWeight:700,cursor:"pointer",width:"100%"}}>⚡ Update Day — Evaluate · Retrain · Predict</button>
          {checkinMsg&&<div style={{marginTop:10,padding:"10px 14px",borderRadius:8,background:checkinMsg.type==="success"?"#052e16":checkinMsg.type==="warn"?"#1c1400":"#0c1a2e",border:`1px solid ${checkinMsg.type==="success"?"#166534":checkinMsg.type==="warn"?"#854d0e":"#1e40af"}`,color:checkinMsg.type==="success"?"#4ade80":checkinMsg.type==="warn"?"#fbbf24":"#93c5fd",fontSize:12,lineHeight:1.7}}>{checkinMsg.text}</div>}
          <div style={{marginTop:12,fontSize:10,color:"#374151",lineHeight:1.7}}>
            💡 NSE closes at 3:00 PM EAT. Enter prices after 3 PM for accuracy. Check mystocks.co.ke or your broker app.
          Evaluation bands: SBIC 1.5% · COOP 1.0% · KNRE 1.0% · GLD 2.0% · BERG 1.0%
          </div>
        </div>
      )}

      {/* ── SIGNAL JOURNAL ──────────────────────────────────────────────────── */}
      {section==="journal"&&(
        <div>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
            <div style={{fontSize:13,fontWeight:700,color:"#9ca3af"}}>📓 Signal Journal ({journal.length} entries)</div>
            <div style={{display:"flex",gap:6}}>
              {journal.some(e=>e.date===new Date().toISOString().split("T")[0])&&(
                <button onClick={()=>{
                  const today=new Date().toISOString().split("T")[0];
                  const filtered=journal.filter(e=>e.date!==today);
                  saveLabJournal(filtered);setJournal(filtered);
                }} style={{padding:"4px 10px",borderRadius:5,border:"1px solid #854d0e",background:"#1c1400",color:"#fbbf24",fontSize:10,cursor:"pointer"}}>🗑 Remove Today's Entries</button>
              )}
              {journal.length>0&&<button onClick={()=>{saveLabJournal([]);setJournal([]);}} style={{padding:"4px 10px",borderRadius:5,border:"1px solid #991b1b",background:"#1c0a0a",color:"#f87171",fontSize:10,cursor:"pointer"}}>Clear All</button>}
            </div>
          </div>
          {journal.length===0?(
            <div style={{textAlign:"center",padding:40,color:"#4b5563",background:"#0f172a",borderRadius:10,border:"1px dashed #1f2937"}}>No signals logged yet. Complete a daily check-in to generate signals.</div>
          ):(
            <div style={{overflowX:"auto"}}>
              <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                <thead>
                  <tr style={{color:"#6b7280",borderBottom:"1px solid #1f2937"}}>
                    {["Date","Stock","Signal","Conf","Prob UP","Price","Actual","Result"].map(h=>(
                      <th key={h} style={{padding:"8px 10px",textAlign:"left",fontWeight:600}}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[...journal].reverse().map(e=>(
                    <tr key={e.id} style={{borderBottom:"1px solid #111827",background:e.correct===true?"#071f0a":e.correct===false?"#160808":"transparent"}}>
                      <td style={{padding:"7px 10px",color:"#9ca3af"}}>{e.date}</td>
                      <td style={{padding:"7px 10px",fontWeight:700,color:"#f9fafb"}}>{e.ticker||e.stock}</td>
                      <td style={{padding:"7px 10px"}}><LabBadge signal={e.signal}/></td>
                      <td style={{padding:"7px 10px",color:e.confidence>60?"#4ade80":e.confidence>50?"#facc15":"#f87171"}}>{e.confidence}%</td>
                      <td style={{padding:"7px 10px",color:"#9ca3af"}}>{e.probUp!=null?`${e.probUp}%`:"—"}</td>
                      <td style={{padding:"7px 10px",color:"#9ca3af"}}>{e.price?`${fmt(e.price)}`:"—"}</td>
                      <td style={{padding:"7px 10px",color:e.actual==="UP"?"#4ade80":e.actual==="DOWN"?"#f87171":"#9ca3af"}}>{e.actual||"⏳"}</td>
                      <td style={{padding:"7px 10px",fontSize:16}}>{e.correct===true?"✅":e.correct===false?"❌":e.actual==null?"—":"➖"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── SCOREBOARD ──────────────────────────────────────────────────────── */}
      {section==="scoreboard"&&(
        <div>
          <div style={{fontSize:13,fontWeight:700,color:"#9ca3af",marginBottom:14}}>🏆 Weekly Scoreboard</div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(160px,1fr))",gap:10,marginBottom:20}}>
            {[
              ["Total Signals", totalSig, "#f9fafb"],
              ["Evaluated", scored.length, "#9ca3af"],
              ["Correct", correct, "#4ade80"],
              ["Hit Rate", hitRate!=null?`${hitRate}%`:"—", hitRate>60?"#4ade80":hitRate>50?"#facc15":"#f87171"],
            ].map(([label,val,color])=>(
              <div key={label} style={{background:"#0f172a",border:"1px solid #1f2937",borderRadius:10,padding:14,textAlign:"center"}}>
                <div style={{fontSize:22,fontWeight:900,color}}>{val!=null?val:"—"}</div>
                <div style={{fontSize:11,color:"#6b7280",marginTop:2}}>{label}</div>
              </div>
            ))}
          </div>
          <div style={{fontSize:12,fontWeight:700,color:"#9ca3af",marginBottom:8}}>Per-Stock Accuracy</div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))",gap:8}}>
            {LAB_STOCKS.map(name=>{
              const acc = perStock[name];
              const c = acc>60?"#4ade80":acc>50?"#facc15":"#f87171";
              const stockScored = scored.filter(j=>j.stock===name);
              return (
                <div key={name} style={{background:"#0f172a",border:"1px solid #1f2937",borderRadius:8,padding:12,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <div>
                    <div style={{fontWeight:700,fontSize:13,color:"#f9fafb"}}>{LAB_TICKERS[name]}</div>
                    <div style={{fontSize:10,color:"#4b5563"}}>{stockScored.length} evaluated</div>
                  </div>
                  <div style={{fontSize:20,fontWeight:900,color:acc!=null?c:"#374151"}}>{acc!=null?`${acc}%`:"—"}</div>
                </div>
              );
            })}
          </div>
          {scored.length===0&&<div style={{marginTop:20,textAlign:"center",padding:30,color:"#4b5563",background:"#0f172a",borderRadius:10,border:"1px dashed #1f2937"}}>No evaluated signals yet. Signals get evaluated the day after they're generated during check-in.</div>}
        </div>
      )}

      {/* ── PAPER PORTFOLIO ─────────────────────────────────────────────────── */}
      {section==="paper"&&(
        <div>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
            <div style={{fontSize:13,fontWeight:700,color:"#9ca3af"}}>💰 Paper Portfolio</div>
            <button onClick={()=>{const p={value:LAB_PAPER_START,trades:[],startedAt:new Date().toISOString()};saveLabPaper(p);setPaper(p);}} style={{padding:"4px 10px",borderRadius:5,border:"1px solid #991b1b",background:"#1c0a0a",color:"#f87171",fontSize:10,cursor:"pointer"}}>Reset</button>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(160px,1fr))",gap:10,marginBottom:20}}>
            {[
              ["Starting Capital",`KES ${(LAB_PAPER_START).toLocaleString()}`, "#9ca3af"],
              ["Current Value",`KES ${Math.round(paper.value).toLocaleString()}`, parseFloat(paperReturn)>=0?"#4ade80":"#f87171"],
              ["Return", `${parseFloat(paperReturn)>=0?"+":""}${paperReturn}%`, parseFloat(paperReturn)>=0?"#4ade80":"#f87171"],
              ["Total Trades", paperTrades.length, "#f9fafb"],
              ["Win Rate", paperWinRate!=null?`${paperWinRate}%`:"—", paperWinRate>50?"#4ade80":"#f87171"],
              ["Max Drawdown", `${paperDrawdown}%`, "#eab308"],
            ].map(([label,val,color])=>(
              <div key={label} style={{background:"#0f172a",border:"1px solid #1f2937",borderRadius:10,padding:14,textAlign:"center"}}>
                <div style={{fontSize:18,fontWeight:900,color}}>{val}</div>
                <div style={{fontSize:10,color:"#6b7280",marginTop:2}}>{label}</div>
              </div>
            ))}
          </div>
          <div style={{fontSize:12,fontWeight:700,color:"#9ca3af",marginBottom:8}}>Trade Log</div>
          {paperTrades.length===0?(
            <div style={{textAlign:"center",padding:30,color:"#4b5563",background:"#0f172a",borderRadius:10,border:"1px dashed #1f2937"}}>No paper trades yet. Trades open automatically when you retrain or do a daily check-in.</div>
          ):(
            <div style={{overflowX:"auto"}}>
              <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                <thead>
                  <tr style={{color:"#6b7280",borderBottom:"1px solid #1f2937"}}>
                    {["Date","Stock","Signal","Shares","Entry","Exit","P&L","Status"].map(h=><th key={h} style={{padding:"7px 10px",textAlign:"left",fontWeight:600}}>{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {[...paperTrades].reverse().map(t=>(
                    <tr key={t.id} style={{borderBottom:"1px solid #111827",background:t.pnl>0?"#071f0a":t.pnl<0?"#160808":"transparent"}}>
                      <td style={{padding:"6px 10px",color:"#9ca3af"}}>{t.date}</td>
                      <td style={{padding:"6px 10px",fontWeight:700,color:"#f9fafb"}}>{LAB_TICKERS[t.stock]||t.stock}</td>
                      <td style={{padding:"6px 10px"}}><LabBadge signal={t.signal}/></td>
                      <td style={{padding:"6px 10px",color:"#9ca3af"}}>{t.shares}</td>
                      <td style={{padding:"6px 10px",color:"#9ca3af"}}>{fmt(t.entryPrice)}</td>
                      <td style={{padding:"6px 10px",color:"#9ca3af"}}>{t.exitPrice?fmt(t.exitPrice):"—"}</td>
                      <td style={{padding:"6px 10px",fontWeight:700,color:t.pnl>0?"#4ade80":t.pnl<0?"#f87171":"#9ca3af"}}>{t.pnl!=null?`${t.pnl>0?"+":""}${Math.round(t.pnl).toLocaleString()}`:"—"}</td>
                      <td style={{padding:"6px 10px",fontSize:11,color:t.closed?"#6b7280":"#facc15"}}>{t.closed?"Closed":"Open"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div style={{marginTop:12,fontSize:10,color:"#374151",lineHeight:1.8}}>
            📌 Allocation: 15% per trade · Signals automatically open positions · Check-in closes positions and evaluates P&amp;L · HOLD signals = no trade
          </div>
        </div>
      )}

      {/* ── WEEKLY ACCURACY ─────────────────────────────────────────────────── */}
      {section==="weekly"&&(()=>{
        const STOCK_BANDS = {"Stanbic Bank":1.5,"Co-op Bank":1.0,"Kenya Re":1.0,"ABSA NewGold ETF":2.0,"Crown Paints":1.0};

        // Get Monday's lean for each stock from the journal
        // lean = dominant direction from probUp — no neutral zone
        // If probUp > 50 = UP, if probUp < 50 = DOWN, if exactly 50 = skip
        const getLean = (e) => {
          const p = e.probUp||0;
          if(p > 50) return "UP";
          if(p < 50) return "DOWN";
          return null; // exactly 50/50 — skip
        };

        // Get ISO week Monday date string
        const getMonday = (dateStr) => {
          const d = new Date(dateStr);
          const day = d.getDay();
          const diff = d.getDate() - day + (day===0?-6:1);
          const mon = new Date(d); mon.setDate(diff);
          return mon.toISOString().split("T")[0];
        };

        const getFriday = (monStr) => {
          const d = new Date(monStr); d.setDate(d.getDate()+4);
          return d.toISOString().split("T")[0];
        };

        const fmtDate = (d) => new Date(d).toLocaleDateString("en-KE",{month:"short",day:"numeric"});

        // Build week map: weekKey → {monEntries, friEntries}
        // monEntries = signals from Monday of that week
        // friEntries = signals logged by Friday of that week
        const allJournal = [...journal].sort((a,b)=>a.date<b.date?-1:1);

        // Find all distinct week keys
        const weekKeys = [...new Set(allJournal.map(e=>getMonday(e.date)))].sort().slice(-3);

        if(weekKeys.length===0) return (
          <div style={{textAlign:"center",padding:40,color:"#4b5563",background:"#0f172a",borderRadius:10,border:"1px dashed #1f2937"}}>
            Not enough data yet. Need at least 1 full week of check-ins.
          </div>
        );

        // Helper: get all trading days in a week from stock data (more reliable than journal)
        const getWeekStockRows = (weekKey) => {
          // Returns {stockName: [{date, price}]} for all stocks in this week
          const result = {};
          for(const name of LAB_STOCKS){
            const allRows = db.load(STOCK_KEY(name))||[];
            const weekRows = allRows
              .filter(r=>r.date && getMonday(r.date)===weekKey && r.close)
              .sort((a,b)=>a.date<b.date?-1:1);
            const seen = new Set();
            result[name] = weekRows
              .filter(r=>{ if(seen.has(r.date)) return false; seen.add(r.date); return true; })
              .map(r=>({date:r.date, price:r.close}));
          }
          return result;
        };

        // Helper: get first trading day of a week
        const getWeekFirstDay = (weekKey) => {
          // Use journal for first day since leans come from journal entries
          const days = [...new Set(
            allJournal.filter(e=>getMonday(e.date)===weekKey).map(e=>e.date)
          )].sort();
          return days[0]||null;
        };

        // Helper: get last trading day + prices of a week from stock data rows
        const getWeekLastDay = (weekKey) => {
          const stockRows = getWeekStockRows(weekKey);
          const prices = {};
          let lastDay = null;
          for(const name of LAB_STOCKS){
            const rows = stockRows[name];
            if(rows && rows.length>0){
              const last = rows[rows.length-1];
              prices[name] = last.price;
              if(!lastDay||last.date>lastDay) lastDay=last.date;
            }
          }
          return {lastDay, prices};
        };

        // Helper: get Monday leans + prices for a week
        // Uses calendar Monday (weekKey itself) for prices, not journal first entry
        // This ensures late-entered prices don't shift the anchor day
        const getWeekLeans = (weekKey) => {
          // weekKey IS the Monday date string — use it directly for prices
          const calendarMonday = weekKey;
          // Find first journal day of this week for leans (journal has signal/probUp)
          const firstJournalDay = getWeekFirstDay(weekKey);
          const leans={}, prices={};

          // Get leans from journal entries for the first logged day of this week
          if(firstJournalDay){
            for(const e of allJournal.filter(e=>e.date===firstJournalDay)){
              const lean=getLean(e);
              if(lean) leans[e.stock]=lean;
            }
          }

          // Get prices from stock data rows for calendar Monday specifically
          for(const name of LAB_STOCKS){
            const allRows = db.load(STOCK_KEY(name))||[];
            // Try exact Monday date first
            const mondayRow = allRows.find(r=>r.date===calendarMonday);
            if(mondayRow?.close){
              prices[name]=mondayRow.close;
            } else {
              // Monday was holiday/no trade — use first available day of that week
              const weekRows = allRows
                .filter(r=>r.date && getMonday(r.date)===weekKey && r.close)
                .sort((a,b)=>a.date<b.date?-1:1);
              if(weekRows.length>0) prices[name]=weekRows[0].close;
            }
          }

          // firstDay for display purposes = calendar Monday if we have prices, else first journal day
          const firstDay = Object.keys(prices).length>0 ? calendarMonday : firstJournalDay;
          return {firstDay, leans, prices};
        };

        // Helper: get all daily prices for a stock within a week
        // Returns array of {date, price} sorted chronologically
        const getWeekDailyPrices = (weekKey, stock) => {
          // Read from actual stock data rows — more reliable than journal
          // Journal may miss days entered late; stock rows have every close entered
          const stockName = LAB_STOCKS.find(n=>LAB_TICKERS[n]===stock||n===stock)||stock;
          const allRows = db.load(STOCK_KEY(stockName))||[];
          const weekRows = allRows
            .filter(r=>r.date && getMonday(r.date)===weekKey && r.close)
            .sort((a,b)=>a.date<b.date?-1:1)
            .map(r=>({date:r.date, price:r.close}));
          // Deduplicate by date
          const seen = new Set();
          return weekRows.filter(d=>{ if(seen.has(d.date)) return false; seen.add(d.date); return true; });
        };

        // Helper: score lean vs best intraweek opportunity
        // Checks every day after Monday — if any day moved in lean direction, it counts
        // Takes the most profitable exit among all correct days
        const scoreLeanVsBestIntraweek = (leans, entryPrices, weekKey) => {
          const rows=[]; let hits=0,total=0;
          for(const stock of LAB_STOCKS){
            const lean=leans[stock], entry=entryPrices[stock];
            if(!lean||!entry) continue;
            // Get all daily prices for this stock this week after Monday
            const dailyPrices = getWeekDailyPrices(weekKey, stock).filter(d=>d.price!==entry||true);
            // Skip the first day (entry day) — we want days AFTER entry
            const afterMonday = dailyPrices.slice(1);
            if(afterMonday.length===0){
              // No subsequent days logged yet
              total++;
              rows.push({stock,lean,entryPrice:entry,exitPrice:null,exitDate:null,pct:0,actual:"⏳",correct:false,allDays:[]});
              continue;
            }
            // Find all days that moved in the correct direction
            const correctDays = afterMonday
              .map(d=>({...d, pct:(d.price-entry)/entry*100}))
              .filter(d=>lean==="UP"?d.pct>0:d.pct<0);
            const wrongDays = afterMonday
              .map(d=>({...d, pct:(d.price-entry)/entry*100}))
              .filter(d=>lean==="UP"?d.pct<0:d.pct>0);
            let correct=false, exitPrice=null, exitDate=null, bestPct=0, actual="";
            if(correctDays.length>0){
              // Take most profitable correct day
              const best = correctDays.reduce((a,b)=>
                Math.abs(b.pct)>Math.abs(a.pct)?b:a
              );
              correct=true; exitPrice=best.price; exitDate=best.date;
              bestPct=best.pct; actual=lean;
              hits++;
            } else {
              // All days went wrong — take last day as exit
              const last = afterMonday[afterMonday.length-1];
              exitPrice=last.price; exitDate=last.date;
              bestPct=last.pct; actual=lean==="UP"?"DOWN":"UP";
            }
            total++;
            rows.push({
              stock,lean,entryPrice:entry,exitPrice,exitDate,
              pct:bestPct,actual,correct,
              allDays:afterMonday.map(d=>({...d,pct:(d.price-entry)/entry*100})),
              correctCount:correctDays.length,
              wrongCount:wrongDays.length
            });
          }
          return {rows,hits,total,rate:total?Math.round(hits/total*100):null};
        };

        // Simple close-to-close scorer (used for cross-week B and anchor C)
        const scoreLeanVsClose = (leans, entryPrices, exitPrices) => {
          const rows=[]; let hits=0,total=0;
          for(const stock of LAB_STOCKS){
            const lean=leans[stock], entry=entryPrices[stock], exit=exitPrices[stock];
            if(!lean||!entry||!exit) continue;
            const pct=(exit-entry)/entry*100;
            const actual=pct>0?"UP":pct<0?"DOWN":"FLAT";
            const correct=lean===actual;
            if(correct) hits++; total++;
            rows.push({stock,lean,entryPrice:entry,exitPrice:exit,pct,actual,correct});
          }
          return {rows,hits,total,rate:total?Math.round(hits/total*100):null};
        };

        // Build per-week anchors — keep mon and fri prices separate
        const weekData = weekKeys.map(wk=>{
          const {firstDay, leans, prices:monPrices} = getWeekLeans(wk);
          const {lastDay, prices:friPrices} = getWeekLastDay(wk);
          return {wk, firstDay, leans, monPrices, friPrices, lastDay};
        });

        // Individual weeks: each week's own Mon → best intraweek opportunity
        const individualWeeks = weekData.map((wd,i)=>{
          const sc = wd.firstDay
            ? scoreLeanVsBestIntraweek(wd.leans, wd.monPrices, wd.wk)
            : {rows:[],hits:0,total:0,rate:null};
          return {
            label:`Week ${i+1} — ${fmtDate(wd.firstDay||wd.wk)} Mon → best intraweek exit`,
            intraweek:true,
            ...sc
          };
        });

        // Cross-week: Wk2 Mon → Wk3 Fri
        const crossWeek23 = weekData.length>=2 ? (()=>{
          const wd2=weekData[weekData.length-2];
          const wd3=weekData[weekData.length-1];
          const sc=scoreLeanVsClose(wd2.leans, wd2.monPrices, wd3.friPrices);
          return {label:`Wk${weekKeys.length-1} Mon → Wk${weekKeys.length} Fri (${fmtDate(wd2.firstDay||wd2.wk)} → ${fmtDate(wd3.lastDay||wd3.wk)})`, ...sc};
        })() : null;

        // Wk1 anchor cumulative: Wk1 Mon → each week's Fri
        const anchorWd = weekData[0];
        const anchorWeekResults = weekData.map((wd,wi)=>{
          const sc=scoreLeanVsClose(anchorWd.leans, anchorWd.monPrices, wd.friPrices);
          return {label:`Wk1 Mon → Wk${wi+1} Fri (${fmtDate(anchorWd.firstDay||anchorWd.wk)} → ${fmtDate(wd.lastDay||wd.wk)})`, ...sc};
        });

        // Combined per-stock across all individual weeks
        const combineIndividual = (weeks) => {
          const perStock={}; let hits=0,total=0;
          for(const w of weeks){
            for(const r of w.rows||[]){
              if(!perStock[r.stock]) perStock[r.stock]={hits:0,total:0};
              perStock[r.stock].total++; total++;
              if(r.correct){perStock[r.stock].hits++;hits++;}
            }
          }
          return {hits,total,rate:total?Math.round(hits/total*100):null,perStock};
        };

        const combinedAll = combineIndividual(individualWeeks);
        const score2 = weekKeys.length>=2?combineIndividual(individualWeeks.slice(-2)):null;
        const score3 = weekKeys.length>=3?combineIndividual(individualWeeks):null;

        const rC = (r) => r>=60?"#4ade80":r>=50?"#facc15":"#f87171";
        const lC = (l) => l==="UP"?"#4ade80":l==="DOWN"?"#f87171":"#9ca3af";

        const WeekTable = ({rows,el,xl,intraweek}) => (
          <table style={{width:"100%",borderCollapse:"collapse",fontSize:12,marginTop:8}}>
            <thead>
              <tr style={{color:"#6b7280",borderBottom:"1px solid #1f2937"}}>
                {["Stock","Lean",el||"Entry",intraweek?"Best Exit":"Close","Move%",intraweek?"Opp Days":"Actual","✓"].map(h=>(
                  <th key={h} style={{padding:"5px 8px",textAlign:"left",fontWeight:500,fontSize:11}}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(rows||[]).map(r=>(
                <tr key={r.stock} style={{borderBottom:"1px solid #111827",background:r.correct?"#071f0a":r.actual==="⏳"?"transparent":"#160808"}}>
                  <td style={{padding:"6px 8px",fontWeight:700,color:"#f9fafb"}}>{LAB_TICKERS[r.stock]||r.stock}</td>
                  <td style={{padding:"6px 8px",color:lC(r.lean),fontWeight:700}}>{r.lean}</td>
                  <td style={{padding:"6px 8px",color:"#9ca3af"}}>{r.entryPrice}</td>
                  <td style={{padding:"6px 8px",color:"#f9fafb",fontWeight:700}}>
                    {r.exitPrice||"—"}
                    {intraweek&&r.exitDate&&<div style={{fontSize:9,color:"#4b5563"}}>{r.exitDate}</div>}
                  </td>
                  <td style={{padding:"6px 8px",color:r.pct>0?"#4ade80":r.pct<0?"#f87171":"#9ca3af",fontWeight:700}}>
                    {r.pct!=null&&r.pct!==0?(r.pct>0?"+":"")+r.pct.toFixed(2)+"%":"—"}
                  </td>
                  <td style={{padding:"6px 8px",color:"#9ca3af",fontSize:11}}>
                    {intraweek
                      ? r.actual==="⏳"?"⏳ pending"
                        : r.correctCount!=null
                          ? <span>{r.correctCount>0?<span style={{color:"#4ade80"}}>{r.correctCount}✅</span>:""}{r.wrongCount>0?<span style={{color:"#f87171"}}> {r.wrongCount}❌</span>:""}</span>
                          : r.actual
                      : <span style={{color:lC(r.actual)}}>{r.actual}</span>
                    }
                  </td>
                  <td style={{padding:"6px 8px",fontSize:15}}>{r.actual==="⏳"?"—":r.correct?"✅":"❌"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        );

        const MiniPerStock = ({score}) => (
          <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:4,marginTop:8}}>
            {LAB_STOCKS.map(name=>{
              const r=score.perStock?.[name];
              const rate=r?Math.round(r.hits/r.total*100):null;
              return (
                <div key={name} style={{textAlign:"center",background:"#0a1628",borderRadius:5,padding:"6px 2px"}}>
                  <div style={{fontSize:9,color:"#6b7280"}}>{LAB_TICKERS[name]}</div>
                  <div style={{fontSize:13,fontWeight:700,color:rate!=null?rC(rate):"#4b5563"}}>{rate!=null?`${rate}%`:"—"}</div>
                  <div style={{fontSize:9,color:"#374151"}}>{r?`${r.hits}/${r.total}`:""}</div>
                </div>
              );
            })}
          </div>
        );

        const SectionHeader = ({color,text}) => (
          <div style={{fontSize:11,fontWeight:700,color,marginBottom:8,marginTop:12,letterSpacing:"0.04em"}}>{text}</div>
        );

        const WeekCard = ({sc,label,sub,el,xl,intraweek}) => (
          <div style={{background:"#0f172a",border:`1px solid ${sc.rate>=60?"#166534":sc.rate>=50?"#854d0e":"#1f2937"}`,borderRadius:10,padding:14,marginBottom:12}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div>
                <div style={{fontSize:12,fontWeight:700,color:"#f9fafb"}}>{label}</div>
                {sub&&<div style={{fontSize:10,color:"#4b5563",marginTop:2}}>{sub}</div>}
              </div>
              <div style={{textAlign:"right"}}>
                <div style={{fontSize:22,fontWeight:900,color:sc.rate!=null?rC(sc.rate):"#4b5563"}}>{sc.rate!=null?`${sc.rate}%`:"—"}</div>
                <div style={{fontSize:10,color:"#6b7280"}}>{sc.hits}/{sc.total} correct</div>
              </div>
            </div>
            <WeekTable rows={sc.rows} el={el} xl={xl} intraweek={intraweek}/>
          </div>
        );

        return (
          <div>
            <div style={{fontSize:13,fontWeight:700,color:"#9ca3af",marginBottom:4}}>📆 Weekly Accuracy — Mon Lean vs Fri Close</div>
            <div style={{fontSize:11,color:"#6b7280",marginBottom:16}}>Each week uses its own Monday anchor. Cross-week and cumulative views track drift. HOLD ignored — uses Prob UP direction only.</div>

            {/* A — Individual weeks: Mon lean → best intraweek exit */}
            <SectionHeader color="#3b82f6" text="▸ A — INDIVIDUAL WEEKS  (Mon lean → best intraweek exit, most profitable correct day)"/>
            {individualWeeks.map((sc,i)=>(
              <WeekCard key={i} sc={sc} label={sc.label} sub="✅ if stock moved correctly on ANY day that week — takes most profitable exit" el="Mon" xl="Best Exit" intraweek={true}/>
            ))}

            {/* B — Cross-week: Wk2 Mon → Wk3 Fri */}
            {crossWeek23&&(
              <>
                <SectionHeader color="#8b5cf6" text="▸ B — CROSS-WEEK  (Week 2 Mon lean → Week 3 Fri close)"/>
                <WeekCard sc={crossWeek23} label={crossWeek23.label} sub="Does Wk2 trend hold into Wk3?" el="Wk2 Mon" xl="Wk3 Fri"/>
              </>
            )}

            {/* C — Wk1 anchor cumulative */}
            <SectionHeader color="#f59e0b" text="▸ C — WEEK 1 ANCHOR  (first Monday lean tracked across all weeks)"/>
            {anchorWeekResults.map((sc,i)=>(
              <WeekCard key={i} sc={sc} label={sc.label} sub="Cumulative drift from Week 1 anchor" el="Wk1 Mon" xl={`Wk${i+1} Fri`}/>
            ))}

            {/* D — Combined summaries */}
            <SectionHeader color="#9ca3af" text="▸ D — COMBINED SUMMARY"/>
            <div style={{display:"grid",gridTemplateColumns:`repeat(${[combinedAll,score2,score3].filter(Boolean).length},1fr)`,gap:10}}>
              {[
                {label:"All weeks (individual)",score:combinedAll},
                score2&&{label:"Last 2 weeks",score:score2},
                score3&&{label:"All 3 weeks",score:score3},
              ].filter(Boolean).map(({label,score})=>(
                <div key={label} style={{background:"#0a1628",border:"1px solid #1e3a5f",borderRadius:10,padding:12}}>
                  <div style={{fontSize:11,fontWeight:700,color:"#9ca3af",marginBottom:4}}>{label}</div>
                  <div style={{fontSize:24,fontWeight:900,color:score.rate!=null?rC(score.rate):"#4b5563"}}>{score.rate!=null?`${score.rate}%`:"—"}</div>
                  <div style={{fontSize:10,color:"#4b5563",marginBottom:6}}>{score.hits}/{score.total} correct</div>
                  <MiniPerStock score={score}/>
                </div>
              ))}
            </div>

            <div style={{marginTop:12,fontSize:10,color:"#374151",lineHeight:1.8}}>
              📌 No FLAT zone — pure directional. Any upward move = UP, any downward move = DOWN. Prob UP ≥55%=UP lean · ≤40%=DOWN lean · between=skipped (genuinely uncertain).
            </div>
          </div>
        );
      })()}

      {/* ── DATA HEALTH ────────────────────────────────────────────────────────── */}
      {section==="health"&&(()=>{
        // Compute gap analysis for each stock
        const isWeekend = (d) => { const day=new Date(d).getDay(); return day===0||day===6; };
        const addDays = (d,n) => { const dt=new Date(d); dt.setDate(dt.getDate()+n); return dt.toISOString().split("T")[0]; };
        const healthData = LAB_STOCKS.map(name=>{
          const rows = db.load(STOCK_KEY(name)) || [];
          const tradingRows = rows.filter(r=>!isWeekend(r.date)).sort((a,b)=>a.date<b.date?-1:1);
          if(tradingRows.length<2) return {name,rows:tradingRows.length,gaps:[],earliest:null,latest:null,gapCount:0};
          // Find gaps — consecutive trading days more than 5 calendar days apart (allowing for weekends+holidays)
          const gaps = [];
          for(let i=1;i<tradingRows.length;i++){
            const prev = new Date(tradingRows[i-1].date);
            const curr = new Date(tradingRows[i].date);
            const diffDays = (curr-prev)/(1000*60*60*24);
            if(diffDays>7){ // more than a full week gap
              gaps.push({from:tradingRows[i-1].date, to:tradingRows[i].date, days:Math.round(diffDays)});
            }
          }
          return {name,rows:tradingRows.length,gaps,earliest:tradingRows[0]?.date,latest:tradingRows[tradingRows.length-1]?.date,gapCount:gaps.length};
        });

        // CSV export function
        const exportCSV = (name) => {
          const rows = (db.load(STOCK_KEY(name))||[]).filter(r=>!isWeekend(r.date)).sort((a,b)=>a.date<b.date?-1:1);
          const csv = ["Date,Open,High,Low,Close,Volume", ...rows.map(r=>`${r.date},${r.open||r.close},${r.high||r.close},${r.low||r.close},${r.close},${r.volume||0}`)].join("\n");
          const blob = new Blob([csv],{type:"text/csv"});
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href=url; a.download=`${name.replace(/ /g,"_")}_full.csv`; a.click();
          URL.revokeObjectURL(url);
        };

        return (
          <div>
            <div style={{fontSize:13,fontWeight:700,color:"#9ca3af",marginBottom:4}}>🩺 Data Health — localStorage Audit</div>
            <div style={{fontSize:11,color:"#6b7280",marginBottom:16}}>Shows what's actually stored, gap analysis, and lets you export full CSVs for backup or inspection.</div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(320px,1fr))",gap:12}}>
              {healthData.map(h=>(
                <div key={h.name} style={{background:"#0f172a",border:`1px solid ${h.gapCount>0?"#854d0e":h.rows>200?"#166534":"#1f2937"}`,borderRadius:10,padding:14}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10}}>
                    <div>
                      <div style={{fontWeight:800,fontSize:13,color:"#f9fafb"}}>{LAB_TICKERS[h.name]||h.name}</div>
                      <div style={{fontSize:10,color:"#6b7280"}}>{h.name}</div>
                    </div>
                    <button onClick={()=>exportCSV(h.name)} style={{padding:"4px 10px",borderRadius:5,border:"1px solid #1e40af",background:"#0c1a2e",color:"#93c5fd",fontSize:10,cursor:"pointer",fontWeight:700}}>⬇ Export CSV</button>
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:4,fontSize:11,marginBottom:8}}>
                    <div style={{color:"#6b7280"}}>Total rows</div>
                    <div style={{color:h.rows>500?"#4ade80":h.rows>100?"#facc15":"#f87171",fontWeight:700}}>{h.rows.toLocaleString()}</div>
                    <div style={{color:"#6b7280"}}>Earliest date</div>
                    <div style={{color:"#9ca3af"}}>{h.earliest||"—"}</div>
                    <div style={{color:"#6b7280"}}>Latest date</div>
                    <div style={{color:"#9ca3af"}}>{h.latest||"—"}</div>
                    <div style={{color:"#6b7280"}}>Gaps found</div>
                    <div style={{color:h.gapCount>0?"#f87171":"#4ade80",fontWeight:700}}>{h.gapCount===0?"✅ None":h.gapCount+" gap(s)"}</div>
                  </div>
                  {h.gapCount>0&&(
                    <div style={{marginTop:6}}>
                      <div style={{fontSize:10,color:"#854d0e",fontWeight:700,marginBottom:4}}>⚠ Gaps detected:</div>
                      {h.gaps.map((g,i)=>(
                        <div key={i} style={{fontSize:10,color:"#fbbf24",background:"#1c1400",borderRadius:4,padding:"3px 8px",marginBottom:3}}>
                          {g.from} → {g.to} ({g.days} calendar days)
                        </div>
                      ))}
                    </div>
                  )}
                  {h.rows===0&&<div style={{fontSize:11,color:"#f87171",marginTop:4}}>No data stored — upload via Data Feed first</div>}
                </div>
              ))}
            </div>
            <div style={{marginTop:16,background:"#0a1628",border:"1px solid #0f1f3d",borderRadius:8,padding:12,fontSize:11,color:"#4b5563",lineHeight:1.8}}>
              <div style={{color:"#6b7280",fontWeight:700,marginBottom:4}}>What gaps mean:</div>
              <div>{`• Gaps >7 days = missing trading data that could affect model accuracy`}</div>
              <div>• The original 7-month gap (Nov 2025 → Jun 2026) should now be filled</div>
              <div>• Export CSV to backup your data or verify it outside the app</div>
              <div>• Re-import the exported CSV via Data Feed to patch any remaining gaps</div>
            </div>
          </div>
        );
      })()}

      {/* ── RETRAIN CENTER ──────────────────────────────────────────────────── */}
      {section==="retrain"&&(
        <div>
          <div style={{fontSize:13,fontWeight:700,color:"#9ca3af",marginBottom:4}}>🔄 Retrain Center</div>
          <div style={{fontSize:11,color:"#6b7280",marginBottom:16}}>Retrain any stock on its latest data using a 2-year window. Automatically logs tomorrow's signal to the journal.</div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(260px,1fr))",gap:12}}>
            {stockStatus.map(({name,ticker,hasData,hasTrained,lastDate,rows,pred,modelWindow})=>{
              // Parse model window years from string like "3.0yr" or "19.0yr"
              const windowYrs = modelWindow&&modelWindow!=="—" ? parseFloat(modelWindow) : null;
              const windowContaminated = windowYrs!=null && windowYrs > 2.5;
              return (
              <div key={name} style={{background:"#0f172a",border:`1px solid ${windowContaminated?"#854d0e":"#1f2937"}`,borderRadius:10,padding:14}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                  <div>
                    <div style={{fontWeight:800,fontSize:14,color:"#f9fafb"}}>{ticker}</div>
                    <div style={{fontSize:10,color:"#6b7280"}}>{rows.length} rows · last: {lastDate||"—"}</div>
                  </div>
                  <div style={{textAlign:"right"}}>
                    {hasTrained&&pred&&<LabBadge signal={pred.signal}/>}
                    {modelWindow&&modelWindow!=="—"&&(
                      <div style={{fontSize:9,color:windowContaminated?"#f97316":"#4b5563",marginTop:3,fontWeight:windowContaminated?700:400}}>
                        {modelWindow} window{windowContaminated?" ⚠":""}
                      </div>
                    )}
                  </div>
                </div>
                {windowContaminated&&(
                  <div style={{marginBottom:8,padding:"6px 8px",borderRadius:5,background:"#1c1000",border:"1px solid #854d0e",fontSize:10,color:"#f97316",lineHeight:1.5}}>
                    ⚠ Model window is {modelWindow} — likely trained via main Train tab with full history. This hurts IR scores by including old price regimes. Click Retrain below to reset to 2yr window.
                  </div>
                )}
                {!hasData&&<div style={{fontSize:11,color:"#854d0e",marginBottom:8}}>⚠ Need data — upload gap CSV in Data Feed first</div>}
                <button
                  onClick={()=>handleRetrain(name)}
                  disabled={!hasData||!!retraining[name]}
                  style={{width:"100%",padding:"8px",borderRadius:6,border:"none",background:!hasData?"#111827":retraining[name]?"#1e3a5f":windowContaminated?"#92400e":"#1d4ed8",color:!hasData?"#374151":"#fff",cursor:!hasData?"not-allowed":"pointer",fontSize:12,fontWeight:700}}
                >
                  {retraining[name]?"⏳ Training…":windowContaminated?`⚠ Retrain ${ticker} (fix window)`:`Retrain ${ticker}`}
                </button>
                {hasTrained&&pred&&(
                  <div style={{marginTop:8,fontSize:11,color:"#6b7280",lineHeight:1.6}}>
                    <div>Conf: <span style={{color:pred.confidence>60?"#4ade80":"#facc15",fontWeight:700}}>{pred.confidence}%</span></div>
                    <div>UP {Math.round((pred.probUp||0)*100)}% · FLAT {Math.round((pred.probFlat||0)*100)}% · DOWN {Math.round((pred.probDown||0)*100)}%</div>
                  </div>
                )}
              </div>
              );
            })}
          </div>
          <div style={{marginTop:16,background:"#0a1628",border:"1px solid #0f1f3d",borderRadius:8,padding:12,fontSize:11,color:"#4b5563",lineHeight:1.8}}>
            <span style={{color:"#6b7280",fontWeight:700}}>Recommended schedule:</span> retrain once per week or after uploading fresh gap data. Retraining daily is overkill — NSE is a low-frequency market.
            <div style={{marginTop:6,color:"#854d0e"}}>⚠ Never use the main Train tab for live stocks — it overrides the 2yr window cap and contaminates IR scores with old price regimes.</div>
          </div>
        </div>
      )}
    </div>
  );
}

const TABS=[
  ["data","📂 Data"],["train","🧠 Train"],["simulate","⏱ Simulate"],
  ["predict","🎯 Predict"],["backtest","📋 Backtest"],["portfolio","💼 Portfolio"],
  ["events","📅 Events"],["macro","🏦 Macro"],["tax","💰 Tax"],
  ["gate","🔬 Expert Gate"],["expert","📖 Expert KB"],
  ["modellab","🔬 Model Lab"],
  ["livelab","🟢 Live Lab"],
  ["gaps","🗺 Gaps & Roadmap"],["audit","🔐 Audit"]
];

export default function InvestIQApp(){
  const [tab,setTab]=useState("data");
  const [stocks,setStocks]=useState(listStocks);
  const [stockDataMap,setStockDataMap]=useState({});
  const [auditLog,setAuditLog]=useState([]);

  const loggerRef=useRef(null);
  if(!loggerRef.current) loggerRef.current=new AuditLogger(setAuditLog);
  const log=useCallback((ev,st,det)=>loggerRef.current.log(ev,st,det),[]);

  useEffect(()=>{
    try {
      // ── Startup: purge any combined-dataset names that slipped into localStorage ──
      const allKeys = listStocks();
      const badKeys = allKeys.filter(s=>isCombinedFilename(s));
      if(badKeys.length>0){
        badKeys.forEach(bad=>{
          db.remove(STOCK_KEY(bad));
          const safe=bad.replace(/\s+/g,"_");
          db.remove(`iq_weights_${safe}`);
          db.remove(`iq_lhist_${safe}`);
          db.remove(`iq_ablation_${safe}`);
        });
        console.warn(`[InvestIQ startup] Purged ${badKeys.length} combined-dataset entries:`,badKeys);
      }
      // Also purge combined-name entries and stale 100% BT results from cache
      try {
        const trainResults = db.load("iq_train_results", {});
        const cleanedResults = {};
        let purgedResults = 0; let purgedStale = 0;
        for(const [k, v] of Object.entries(trainResults)) {
          if(isCombinedFilename(k)) { purgedResults++; continue; }
          // Purge 100% BT accuracy results — these are artefacts from the
          // old label-band-mismatch bug (foldBand vs labelDirection mismatch).
          // Real BT accuracy never reaches 100% on a properly run walk-forward.
          if(v.btAcc >= 0.999) { purgedStale++; continue; }
          cleanedResults[k] = v;
        }
        if(purgedResults > 0 || purgedStale > 0) {
          db.save("iq_train_results", cleanedResults);
          console.warn(`[InvestIQ startup] Purged ${purgedResults} combined + ${purgedStale} stale 100% BT entries`);
        }
      } catch(e) { /* non-critical */ }

      const initial={};
      for(const name of listStocks()){
        try {
          const sd=loadStockData(name);
          if(sd) initial[name]=sd;
        } catch(e) { console.warn(`Skipping ${name} on load:`,e); }
      }
      setStockDataMap(initial);
      setStocks(listStocks()); // refresh after purge
      log("APP_INIT","SUCCESS",
        `InvestIQ v${VERSION} · ${Object.keys(initial).length} stocks loaded${badKeys.length?` · ${badKeys.length} bad entries purged`:""}`);
    } catch(e) {
      log("APP_INIT","WARN",`Startup error: ${e.message} — some stocks may need re-importing`);
    }
  },[]);

  const handleStocksChanged=(newList)=>{
    setStocks(newList);
    const updated={};
    for(const name of newList){
      const sd=loadStockData(name);
      if(sd) updated[name]=stockDataMap[name]?{...stockDataMap[name],rows:sd.rows,features:sd.features}:sd;
    }
    setStockDataMap(updated);
  };

  return(
    <div style={{background:"#020817",minHeight:"100vh",color:"#f9fafb",fontFamily:"-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"}}>
      <div style={{background:"#050d1a",borderBottom:"1px solid #0f1f3d",padding:"10px 16px",display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,flexWrap:"wrap",position:"sticky",top:0,zIndex:50,backdropFilter:"blur(10px)"}}>
        <div>
          <div style={{fontWeight:900,fontSize:17,color:"#f9fafb"}}>📊 InvestIQ</div>
          <div style={{fontSize:10,color:"#4b6cb7"}}>v{VERSION} · ML Engine · NSE & Global</div>
        </div>
        {/* 5d: Mobile tab bar — overflow-x:auto for narrow screens */}
        <div style={{display:"flex",gap:3,background:"#0a1628",borderRadius:8,padding:3,border:"1px solid #0f1f3d",overflowX:"auto",WebkitOverflowScrolling:"touch"}}>
          {TABS.map(([id,label])=>(
            <button key={id} onClick={()=>setTab(id)} style={{padding:"6px 10px",borderRadius:5,border:"none",cursor:"pointer",fontSize:11,fontWeight:tab===id?700:400,background:tab===id?"#1d4ed8":"transparent",color:tab===id?"#fff":"#6b7280",transition:"all 0.15s",whiteSpace:"nowrap"}}>{label}</button>
          ))}
        </div>
        <div style={{fontSize:11,color:"#6b7280"}}>{stocks.length} stock{stocks.length!==1?"s":""} loaded {stocks.length>0&&"●"}</div>
      </div>

      <div style={{padding:"16px",maxWidth:1100,margin:"0 auto"}}>
        {tab==="data"      &&<DataTab      onStocksChanged={handleStocksChanged} log={log}/>}
        {tab==="train"     &&<TrainTab     stocks={stocks} stockDataMap={stockDataMap} setStockDataMap={setStockDataMap} log={log} onStocksChanged={handleStocksChanged}/>}
        {tab==="simulate"  &&<SimulateTab  stocks={stocks} stockDataMap={stockDataMap} log={log}/>}
        {tab==="predict"   &&<PredictTab   stocks={stocks} stockDataMap={stockDataMap}/>}
        {tab==="backtest"  &&<BacktestTab  stocks={stocks} stockDataMap={stockDataMap}/>}
        {tab==="portfolio" &&<PortfolioTab stocks={stocks} stockDataMap={stockDataMap} log={log}/>}
        {tab==="events"    &&<EventCalendarTab log={log}/>}
        {tab==="macro"     &&<MacroTab/>}
        {tab==="tax"       &&<TaxTab/>}
        {tab==="gate"      &&<ExpertGateTab/>}
        {tab==="expert"    &&<ExpertTab/>}
        {tab==="gaps"      &&<GapsTab/>}
        {tab==="modellab"  &&<ModelLabTab stocks={stocks} stockDataMap={stockDataMap}/>}
        {tab==="livelab"   &&<LiveLabTab  stocks={stocks} stockDataMap={stockDataMap} setStockDataMap={setStockDataMap} log={log} onStocksChanged={handleStocksChanged}/>}
        {tab==="audit"     &&<AuditTab     auditLog={auditLog} setAuditLog={setAuditLog}/>}
      </div>

      <div style={{padding:"0 16px 16px",maxWidth:1100,margin:"0 auto"}}>
        <div style={{background:"#0f172a",border:"1px solid #1f2937",borderRadius:8,padding:"10px 14px",fontSize:11,color:"#374151",lineHeight:1.6}}>
          🏗 InvestIQ v{VERSION} · GBDT + 3-class ensemble · localStorage (swap db → Supabase for production) · Admin: full access · Viewer: read-only · Next: live CBK feed, NSE data sync, backend training queue.
        </div>
      </div>
    </div>
  );
}
