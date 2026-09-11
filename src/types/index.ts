// Core data types for InvestIQ

export interface StockRow {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  _boundary?: boolean;
  _corpAction?: number;
  _gapBefore?: boolean;
}

export interface StockData {
  name: string;
  rows: StockRow[];
  features?: Record<string, number>[];
  _warnings?: string[];
  _detectedStockName?: string;
  _lastUpdated?: string;
}

export interface ModelWeights {
  stock: string;
  horizon: number;
  weights: Record<string, any>;
  accuracy: number;
  createdAt: string;
  version: string;
}

export interface TrainingResult {
  stock: string;
  horizon: number;
  btAcc: number;
  inSampleAcc: number;
  nSamples: number;
  classBalance: {
    up: number;
    flat: number;
    down: number;
  };
  features: string[];
  createdAt: string;
}

export interface Prediction {
  date: string;
  direction: 'UP' | 'DOWN' | 'NEUTRAL';
  confidence: number;
  predictedReturn: number;
  actualReturn?: number;
  correct?: boolean;
}

export interface ExpertData {
  npl: number;
  divYield: number;
  taxFree: boolean;
  tag: string;
  liq: number;
  macroSens: number;
  maxAlloc: number;
  spread: number;
  advisory: string;
  macroNote: string;
}

export interface PortfolioEntry {
  asset: string;
  qty: number;
  buyPrice: number;
  currentPrice?: number;
  pnl?: number;
  pnlPct?: number;
  addedAt: string;
}

export interface AuditLogEntry {
  id: string;
  ts: string;
  event: string;
  status: string;
  detail: string;
}

export interface MacroData {
  cbk_rate: number;
  inflation: number;
  usd_kes: number;
  gdp_growth: number;
  date?: string;
}

// NSE specific types
export interface NSETicker {
  code: string;
  name: string;
  lastPrice?: number;
  change?: number;
  changePct?: number;
  volume?: number;
  lastUpdated?: string;
}

// Database row types (matching Supabase schema)
export interface DatabaseStock {
  id: string;
  name: string;
  ticker: string;
  data: StockRow[];
  last_updated: string;
  created_at: string;
}

export interface DatabaseModelWeight {
  id: string;
  stock_name: string;
  horizon: number;
  weights: Record<string, any>;
  accuracy: number;
  created_at: string;
  version: string;
}

export interface DatabaseTrainingResult {
  id: string;
  stock_name: string;
  result_data: TrainingResult;
  created_at: string;
}