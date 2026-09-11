'use client'

import type { StockData } from '@/types'

interface PortfolioTabProps {
  stocks: string[];
  stockDataMap: Record<string, StockData>;
  log: (event: string, status: string, detail?: string) => void;
}

export default function PortfolioTab({ stocks, stockDataMap, log }: PortfolioTabProps) {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-slate-50 mb-2">Portfolio</h2>
        <p className="text-slate-400">
          Track your NSE investments and performance.
        </p>
      </div>

      <div className="bg-slate-900 rounded-lg p-6">
        <div className="text-center py-12 text-slate-400">
          <div className="text-4xl mb-4">💼</div>
          <h3 className="text-lg font-medium text-slate-200 mb-2">Portfolio Coming Soon</h3>
          <p>
            Investment tracking and performance analysis will be available soon.
          </p>
        </div>
      </div>
    </div>
  );
}