// Feature Engineering - Extracted from InvestIQ
import { TA, rollingReturnStd, rollingCorr } from './indicators'
import { getCbkRateOnDate, detectRegime } from './macro'
import type { StockRow, StockData, MacroData } from '@/types'

// Core feature keys - 11 features after ablation study
export const FEAT_KEYS = [
  "pvE21",        // price vs EMA21: short-term trend position
  "pvE50",        // price vs EMA50: medium-term trend position  
  "pvE200",       // price vs EMA200: long-term trend position
  "e9v21",        // EMA9 vs EMA21: short-term momentum cross
  "e21v50",       // EMA21 vs EMA50: medium-term momentum cross
  "rsi14",        // RSI 14: momentum oscillator
  "bbPct",        // Bollinger Band %: price position within volatility envelope
  "atrPct",       // ATR%: current volatility regime
  "roc20",        // 20-day rate of change: medium momentum
  "macdAbove",    // MACD signal line cross: trend direction change
  "macroCbkNorm", // CBK rate normalised: tight/loose policy regime
];

// 6-level continuous regime encoding
const REGIME_ENCODING: Record<string, number> = {
  expansionary: -1.0,
  neutral: 0.0,
  currency_stress: 0.3,
  inflationary: 0.6,
  tight: 0.8,
  stagflation: 1.0,
};

export interface FeatureRow {
  pvE21: number | null;
  pvE50: number | null; 
  pvE200: number | null;
  e9v21: number | null;
  e21v50: number | null;
  rsi14: number | null;
  bbPct: number | null;
  atrPct: number | null;
  roc20: number | null;
  macdAbove: number | null;
  macroCbkNorm: number;
  [key: string]: number | null;
}

export function buildAllFeatures(
  rows: StockRow[], 
  macroOverride: MacroData | null = null,
  stockName: string = "",
  stockDataMap: Record<string, StockData> = {}
): FeatureRow[] {
  const cl = rows.map(r => r.close);
  
  // Calculate all technical indicators
  const e9 = TA.ema(cl, 9);
  const e21 = TA.ema(cl, 21);
  const e50 = TA.ema(cl, 50);
  const e200 = TA.ema(cl, 200);
  const rsi14 = TA.rsi(cl, 14);
  const macd = TA.macd(cl);
  const bb = TA.bb(cl, 20);
  const atr = TA.atr(rows, 14);
  const roc20 = TA.roc(cl, 20);

  // Default macro if none provided
  const defaultMacro: MacroData = {
    cbk_rate: 13,
    inflation: 4.5, 
    usd_kes: 129.5,
    gdp_growth: 5.0
  };

  return rows.map((r, i) => {
    // Get historical CBK rate for this date
    const historicalCbkRate = getCbkRateOnDate(r.date);
    const cbkNorm = Math.max(0, Math.min(1, (historicalCbkRate - 8) / 10));
    
    const rowMacro = macroOverride || { ...defaultMacro, cbk_rate: historicalCbkRate };
    const regime = detectRegime(rowMacro);
    const regimeVal = REGIME_ENCODING[regime] ?? 0.0;

    return {
      pvE21: e21[i] ? (r.close - e21[i]!) / e21[i]! * 100 : null,
      pvE50: e50[i] ? (r.close - e50[i]!) / e50[i]! * 100 : null,
      pvE200: e200[i] ? (r.close - e200[i]!) / e200[i]! * 100 : null,
      e9v21: e9[i] && e21[i] ? e9[i]! - e21[i]! : null,
      e21v50: e21[i] && e50[i] ? e21[i]! - e50[i]! : null,
      rsi14: rsi14[i],
      macdAbove: macd.macdLine[i] !== null && macd.signal[i] !== null 
        ? (macd.macdLine[i]! > macd.signal[i]! ? 1 : -1) : null,
      bbPct: bb[i].pct,
      atrPct: atr[i] && r.close ? atr[i]! / r.close * 100 : null,
      roc20: roc20[i],
      macroCbkNorm: cbkNorm,
      
      // Additional features (not in core FEAT_KEYS but may be useful)
      macroRegime: regimeVal,
      corpAction: r._corpAction ?? 0,
    };
  });
}

// Normalize features for ML training
export function normalizeFeatures(features: FeatureRow[]): {
  normalized: FeatureRow[],
  stats: Record<string, { mean: number, std: number }>
} {
  const stats: Record<string, { mean: number, std: number }> = {};
  
  // Calculate mean and std for each feature
  for (const key of FEAT_KEYS) {
    const values = features
      .map(f => f[key])
      .filter(v => v !== null) as number[];
    
    if (values.length === 0) {
      stats[key] = { mean: 0, std: 1 };
      continue;
    }
    
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
    const std = Math.sqrt(variance) || 1; // Prevent division by zero
    
    stats[key] = { mean, std };
  }
  
  // Normalize features
  const normalized = features.map(row => {
    const normalizedRow: FeatureRow = { ...row };
    
    for (const key of FEAT_KEYS) {
      if (normalizedRow[key] !== null && stats[key]) {
        normalizedRow[key] = (normalizedRow[key]! - stats[key].mean) / stats[key].std;
      }
    }
    
    return normalizedRow;
  });
  
  return { normalized, stats };
}

// Apply normalization using existing stats
export function applyNormalization(
  features: FeatureRow[], 
  stats: Record<string, { mean: number, std: number }>
): FeatureRow[] {
  return features.map(row => {
    const normalizedRow: FeatureRow = { ...row };
    
    for (const key of FEAT_KEYS) {
      if (normalizedRow[key] !== null && stats[key]) {
        normalizedRow[key] = (normalizedRow[key]! - stats[key].mean) / stats[key].std;
      }
    }
    
    return normalizedRow;
  });
}

// Convert feature row to vector for ML training
export function featureRowToVector(row: FeatureRow): number[] {
  return FEAT_KEYS.map(key => row[key] ?? 0);
}

// Auto-calibrate deadband to target ~30% FLAT labels
// Prevents the 65%-FLAT collapse on low-volatility or short datasets
export function calibrateDeadband(
  rows: StockRow[],
  horizon: number,
  targetFlatPct: number = 0.30
): number {
  const DEFAULT = { 30: 2.0, 60: 3.5, 90: 5.0 } as Record<number, number>;

  if (!rows || rows.length < horizon + 30) {
    return DEFAULT[horizon] ?? 2.0;
  }

  // Collect absolute returns for this horizon
  const returns: number[] = [];
  for (let i = 50; i < rows.length - horizon; i++) {
    if ((rows[i] as any)?._boundary || (rows[i + horizon] as any)?._boundary) continue;
    const ret = (rows[i + horizon].close - rows[i].close) / rows[i].close * 100;
    if (isFinite(ret)) returns.push(Math.abs(ret));
  }

  if (returns.length < 20) return DEFAULT[horizon] ?? 2.0;

  returns.sort((a, b) => a - b);

  // Band = targetFlatPct-th percentile of |returns|
  const idx = Math.floor(targetFlatPct * returns.length);
  const band = returns[Math.min(idx, returns.length - 1)];

  // Floor 0.5% — let auto-calibration work on short datasets
  return Math.max(0.5, Math.min(band, 15.0));
}