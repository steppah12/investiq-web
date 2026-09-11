// Technical Analysis Indicators - Extracted from InvestIQ
import type { StockRow } from '@/types'

export const TA = {
  sma(arr: number[], n: number): (number | null)[] {
    return arr.map((_, i) => 
      i < n-1 ? null : arr.slice(i-n+1, i+1).reduce((a,b) => a+b, 0) / n
    );
  },

  ema(arr: number[], n: number): (number | null)[] {
    const k = 2/(n+1);
    const out = new Array(arr.length).fill(null);
    let e: number | null = null;
    
    for (let i = 0; i < arr.length; i++) {
      if (e === null) {
        if (i >= n-1) e = arr.slice(0, n).reduce((a,b) => a+b, 0) / n;
      } else {
        e = arr[i] * k + e * (1-k);
      }
      if (e !== null) out[i] = e;
    }
    return out;
  },

  rsi(arr: number[], n: number = 14): (number | null)[] {
    const out = new Array(arr.length).fill(null);
    if (arr.length < n + 1) return out;
    
    let gA = 0, lA = 0;
    for (let i = 1; i <= n; i++) {
      const d = arr[i] - arr[i-1];
      if (d > 0) gA += d;
      else lA -= d;
    }
    gA /= n;
    lA /= n;
    
    out[n] = lA === 0 ? 100 : 100 - 100/(1 + gA/lA);
    
    for (let i = n+1; i < arr.length; i++) {
      const d = arr[i] - arr[i-1];
      gA = (gA * (n-1) + Math.max(0, d)) / n;
      lA = (lA * (n-1) + Math.max(0, -d)) / n;
      out[i] = lA === 0 ? 100 : 100 - 100/(1 + gA/lA);
    }
    return out;
  },

  macd(arr: number[]): {
    macdLine: (number | null)[],
    signal: (number | null)[],
    histogram: (number | null)[]
  } {
    const e12 = TA.ema(arr, 12);
    const e26 = TA.ema(arr, 26);
    const ml = arr.map((_, i) => 
      e12[i] && e26[i] ? e12[i]! - e26[i]! : null
    );
    
    const valid = ml.filter(v => v !== null) as number[];
    const sf = TA.ema(valid, 9);
    const sig = new Array(arr.length).fill(null);
    
    let vi = 0;
    for (let i = 0; i < arr.length; i++) {
      if (ml[i] !== null) sig[i] = sf[vi++] ?? null;
    }
    
    return {
      macdLine: ml,
      signal: sig,
      histogram: arr.map((_, i) => 
        ml[i] !== null && sig[i] !== null ? ml[i]! - sig[i]! : null
      )
    };
  },

  bb(arr: number[], n: number = 20, k: number = 2): Array<{
    upper: number | null,
    mid: number | null,
    lower: number | null,
    pct: number | null,
    width: number | null
  }> {
    const mid = TA.sma(arr, n);
    return arr.map((_, i) => {
      if (mid[i] === null) {
        return { upper: null, mid: null, lower: null, pct: null, width: null };
      }
      
      const sl = arr.slice(i-n+1, i+1);
      const m = mid[i]!;
      const std = Math.sqrt(sl.reduce((s, v) => s + (v - m)**2, 0) / n);
      const up = m + k * std;
      const lo = m - k * std;
      
      return {
        upper: up,
        mid: m,
        lower: lo,
        pct: (arr[i] - lo) / (up - lo),
        width: (up - lo) / m
      };
    });
  },

  atr(rows: StockRow[], n: number = 14): (number | null)[] {
    const trs = rows.map((r, i) => 
      i === 0 
        ? r.high - r.low
        : Math.max(
            r.high - r.low,
            Math.abs(r.high - rows[i-1].close),
            Math.abs(r.low - rows[i-1].close)
          )
    );
    return TA.sma(trs, n);
  },

  obv(rows: StockRow[]): number[] {
    const out = [0];
    for (let i = 1; i < rows.length; i++) {
      const p = out[i-1];
      if (rows[i].close > rows[i-1].close) {
        out.push(p + rows[i].volume);
      } else if (rows[i].close < rows[i-1].close) {
        out.push(p - rows[i].volume);
      } else {
        out.push(p);
      }
    }
    return out;
  },

  stoch(rows: StockRow[], n: number = 14): (number | null)[] {
    return rows.map((_, i) => {
      if (i < n - 1) return null;
      
      const sl = rows.slice(i - n + 1, i + 1);
      const lo = Math.min(...sl.map(r => r.low));
      const hi = Math.max(...sl.map(r => r.high));
      
      return hi === lo ? 50 : ((rows[i].close - lo) / (hi - lo)) * 100;
    });
  },

  volSpike(rows: StockRow[], n: number = 20): (number | null)[] {
    const vols = rows.map(r => r.volume);
    const avg = TA.sma(vols, n);
    return rows.map((r, i) => avg[i] ? r.volume / avg[i]! : 1);
  },

  roc(arr: number[], n: number): (number | null)[] {
    return arr.map((v, i) => 
      i >= n && arr[i-n] !== 0 ? ((v - arr[i-n]) / arr[i-n]) * 100 : null
    );
  }
};

// Rolling statistics utilities
export function rollingReturnStd(closes: number[], n: number = 20): number[] {
  if (!closes || closes.length < n + 1) {
    return new Array(closes?.length || 0).fill(0);
  }
  
  const out = new Array(closes.length).fill(0);
  
  for (let i = n; i < closes.length; i++) {
    const rets: number[] = [];
    for (let j = i - n + 1; j <= i; j++) {
      if (closes[j-1] > 0) {
        rets.push((closes[j] - closes[j-1]) / closes[j-1] * 100);
      }
    }
    
    if (rets.length < 5) {
      out[i] = 0;
      continue;
    }
    
    const m = rets.reduce((s, v) => s + v, 0) / rets.length;
    out[i] = Math.sqrt(rets.reduce((s, v) => s + (v - m)**2, 0) / rets.length);
  }
  
  return out;
}

export function rollingCorr(closes1: number[], closes2: number[], n: number = 20): number[] {
  if (!closes1 || !closes2 || closes1.length < n + 1 || closes2.length < n + 1) {
    return new Array(Math.min(closes1?.length || 0, closes2?.length || 0)).fill(0);
  }
  
  const len = Math.min(closes1.length, closes2.length);
  const out = new Array(len).fill(0);
  
  for (let i = n; i < len; i++) {
    const r1: number[] = [];
    const r2: number[] = [];
    
    for (let j = i - n + 1; j <= i; j++) {
      if (closes1[j-1] > 0 && closes2[j-1] > 0) {
        r1.push((closes1[j] - closes1[j-1]) / closes1[j-1]);
        r2.push((closes2[j] - closes2[j-1]) / closes2[j-1]);
      }
    }
    
    if (r1.length < 5) {
      out[i] = 0;
      continue;
    }
    
    const m1 = r1.reduce((s, v) => s + v, 0) / r1.length;
    const m2 = r2.reduce((s, v) => s + v, 0) / r2.length;
    
    let cov = 0, s1 = 0, s2 = 0;
    for (let k = 0; k < r1.length; k++) {
      cov += (r1[k] - m1) * (r2[k] - m2);
      s1 += (r1[k] - m1) ** 2;
      s2 += (r2[k] - m2) ** 2;
    }
    
    out[i] = (s1 > 0 && s2 > 0) ? cov / (Math.sqrt(s1) * Math.sqrt(s2)) : 0;
  }
  
  return out;
}