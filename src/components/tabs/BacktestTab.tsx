'use client'

import type { StockData } from '@/types'

interface BacktestTabProps {
  stocks: string[];
  stockDataMap: Record<string, StockData>;
}

export default function BacktestTab({ stocks, stockDataMap }: BacktestTabProps) {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-slate-50 mb-2">Backtesting</h2>
        <p className="text-slate-400">
          Test your models on historical data with walk-forward validation.
        </p>
      </div>

      <div className="bg-slate-900 rounded-lg p-6">
        <div className="text-center py-12 text-slate-400">
          <div className="text-4xl mb-4">📋</div>
          <h3 className="text-lg font-medium text-slate-200 mb-2">Backtesting Coming Soon</h3>
          <p>
            Historical performance analysis will be available after model training.
          </p>
        </div>
      </div>
    </div>
  );
}