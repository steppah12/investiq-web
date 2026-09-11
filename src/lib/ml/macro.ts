// Macro Economic Data and Utilities
import type { MacroData } from '@/types'

// Historical CBK rates
const CBK_HISTORY = [
  {from:"2019-01-01", to:"2020-03-01", rate:9.0},
  {from:"2020-03-01", to:"2020-04-01", rate:8.25},
  {from:"2020-04-01", to:"2022-05-01", rate:7.0},
  {from:"2022-05-01", to:"2022-09-01", rate:7.5},
  {from:"2022-09-01", to:"2023-02-01", rate:8.25},
  {from:"2023-02-01", to:"2023-06-01", rate:9.5},
  {from:"2023-06-01", to:"2023-12-01", rate:10.5},
  {from:"2023-12-01", to:"2024-02-01", rate:12.5},
  {from:"2024-02-01", to:"2024-08-01", rate:13.0},
  {from:"2024-08-01", to:"2025-04-01", rate:12.0},
  {from:"2025-04-01", to:"2099-01-01", rate:10.75},
];

export function getCbkRateOnDate(dateStr: string): number {
  const d = dateStr.slice(0, 10);
  const entry = CBK_HISTORY.find(e => d >= e.from && d < e.to);
  return entry ? entry.rate : 13.0;
}

// Detect macroeconomic regime based on current conditions
export function detectRegime(macro: MacroData): string {
  const { cbk_rate, inflation, usd_kes, gdp_growth } = macro;
  
  // Stagflation: high inflation + low growth + tight policy
  if (inflation > 6.0 && gdp_growth < 3.0 && cbk_rate > 12.0) {
    return 'stagflation';
  }
  
  // Tight monetary policy: high CBK rate
  if (cbk_rate > 11.0) {
    return 'tight';
  }
  
  // Inflationary pressure: high inflation
  if (inflation > 5.5) {
    return 'inflationary';
  }
  
  // Currency stress: weak KES
  if (usd_kes > 135.0) {
    return 'currency_stress';
  }
  
  // Expansionary: low rates + good growth
  if (cbk_rate < 9.0 && gdp_growth > 4.0) {
    return 'expansionary';
  }
  
  // Default neutral
  return 'neutral';
}

// NSE Earnings Calendar
export const NSE_EARNINGS = [
  {stock:"Equity Bank", date:"2024-03-14"}, {stock:"Equity Bank", date:"2024-08-29"},
  {stock:"KCB Group", date:"2024-03-21"}, {stock:"KCB Group", date:"2024-09-26"},
  {stock:"Safaricom", date:"2024-05-10"}, {stock:"Safaricom", date:"2024-11-08"},
  {stock:"EABL", date:"2024-02-28"}, {stock:"EABL", date:"2024-09-12"},
  {stock:"Co-op Bank", date:"2024-03-28"}, {stock:"Co-op Bank", date:"2024-08-22"},
  {stock:"BAT Kenya", date:"2024-03-07"}, {stock:"Acorn REIT", date:"2024-04-18"},
  {stock:"Stanbic Bank", date:"2024-03-15"}, {stock:"I&M Group", date:"2024-03-20"},
  {stock:"NCBA Group", date:"2024-03-25"}, {stock:"Absa Kenya", date:"2024-03-22"},
];

// Dividend History
export const DIVIDEND_HISTORY: Record<string, Array<{exDate: string, amount: number}>> = {
  "Safaricom": [{exDate:"2024-09-20", amount:0.76}, {exDate:"2023-09-22", amount:0.64}],
  "Equity Bank": [{exDate:"2024-10-04", amount:4.00}, {exDate:"2023-10-06", amount:3.00}],
  "KCB Group": [{exDate:"2024-09-27", amount:2.00}, {exDate:"2023-09-29", amount:1.00}],
  "EABL": [{exDate:"2024-11-15", amount:3.75}, {exDate:"2023-11-10", amount:2.50}],
  "Co-op Bank": [{exDate:"2024-10-11", amount:1.50}, {exDate:"2023-10-13", amount:1.00}],
  "BAT Kenya": [{exDate:"2024-08-30", amount:22.0}, {exDate:"2023-09-01", amount:20.0}],
  "Stanbic Bank": [{exDate:"2024-09-15", amount:3.50}],
  "I&M Group": [{exDate:"2024-10-01", amount:2.80}],
};

const BANK_STOCKS = ["KCB Group", "Equity Bank", "Co-op Bank", "Stanbic Bank", "NCBA Group", "Absa Kenya", "I&M Group"];

export function checkDividendCapture(stockName: string): {
  daysToExDate: number,
  amount: number,
  exDate: string,
  historicalAvgRise: number
} | null {
  const divs = DIVIDEND_HISTORY[stockName];
  if (!divs || !divs.length) return null;
  
  const today = new Date();
  const upcoming = divs.map(d => {
    const exMs = new Date(d.exDate).getTime();
    return { ...d, msToEx: exMs - today.getTime() };
  }).filter(d => d.msToEx > 0).sort((a, b) => a.msToEx - b.msToEx);
  
  if (!upcoming.length) return null;
  
  const next = upcoming[0];
  const daysToExDate = Math.round(next.msToEx / 86400000);
  
  if (daysToExDate > 45) return null;
  
  return {
    daysToExDate,
    amount: next.amount,
    exDate: next.exDate,
    historicalAvgRise: BANK_STOCKS.includes(stockName) ? 6.2 : 4.1
  };
}