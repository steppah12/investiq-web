'use client'

import type { StockData } from '@/types'

interface LiveLabTabProps {
  stocks: string[];
  stockDataMap: Record<string, StockData>;
  setStockDataMap: (data: Record<string, StockData>) => void;
  log: (event: string, status: string, detail?: string) => void;
  onStocksChanged: (stocks: string[]) => void;
}

export default function LiveLabTab({ 
  stocks, 
  stockDataMap, 
  setStockDataMap, 
  log, 
  onStocksChanged 
}: LiveLabTabProps) {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-slate-50 mb-2">Live Lab</h2>
        <p className="text-slate-400">
          Real-time testing and model performance tracking.
        </p>
      </div>

      <div className="bg-slate-900 rounded-lg p-6">
        <div className="text-center py-12 text-slate-400">
          <div className="text-4xl mb-4">🟢</div>
          <h3 className="text-lg font-medium text-slate-200 mb-2">Live Lab Coming Soon</h3>
          <p>
            Real-time model testing and performance journaling will be available after deployment.
          </p>
          <div className="mt-4 text-sm">
            <p>This is where you had the 2-week successful testing period!</p>
            <p>We'll recreate that functionality with proper data persistence.</p>
          </div>
        </div>
      </div>
    </div>
  );
}