'use client'

import type { StockData } from '@/types'

interface PredictTabProps {
  stocks: string[];
  stockDataMap: Record<string, StockData>;
}

export default function PredictTab({ stocks, stockDataMap }: PredictTabProps) {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-slate-50 mb-2">Stock Predictions</h2>
        <p className="text-slate-400">
          Generate ML-powered predictions for your NSE stocks.
        </p>
      </div>

      <div className="bg-slate-900 rounded-lg p-6">
        <div className="text-center py-12 text-slate-400">
          <div className="text-4xl mb-4">🎯</div>
          <h3 className="text-lg font-medium text-slate-200 mb-2">Predictions Coming Soon</h3>
          <p>
            Real-time stock predictions will be available after model training is complete.
          </p>
        </div>
      </div>
    </div>
  );
}