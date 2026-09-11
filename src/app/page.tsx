'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { listStocks, db } from '@/lib/database'
import type { StockData, AuditLogEntry } from '@/types'

// Tab components (we'll create these next)
import DataTab from '@/components/tabs/DataTab'
import TrainTab from '@/components/tabs/TrainTab'
import PredictTab from '@/components/tabs/PredictTab'
import BacktestTab from '@/components/tabs/BacktestTab'
import PortfolioTab from '@/components/tabs/PortfolioTab'
import LiveLabTab from '@/components/tabs/LiveLabTab'

const VERSION = "9.5.31";

const TABS = [
  ["data", "📂 Data"],
  ["train", "🧠 Train"],
  ["predict", "🎯 Predict"],
  ["backtest", "📋 Backtest"],
  ["portfolio", "💼 Portfolio"],
  ["livelab", "🟢 Live Lab"],
];

class AuditLogger {
  constructor(private setter: (fn: (prev: AuditLogEntry[]) => AuditLogEntry[]) => void) {}
  
  log(event: string, status: string, detail: string = ""): AuditLogEntry {
    const entry: AuditLogEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
      ts: new Date().toISOString(),
      event,
      status,
      detail
    };
    
    this.setter(prev => [entry, ...prev].slice(0, 200));
    return entry;
  }
}

export default function Home() {
  const [tab, setTab] = useState("data");
  const [stocks, setStocks] = useState<string[]>([]);
  const [stockDataMap, setStockDataMap] = useState<Record<string, StockData>>({});
  const [auditLog, setAuditLog] = useState<AuditLogEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const loggerRef = useRef<AuditLogger | null>(null);
  if (!loggerRef.current) {
    loggerRef.current = new AuditLogger(setAuditLog);
  }
  
  const log = useCallback((event: string, status: string, detail: string = "") => {
    loggerRef.current?.log(event, status, detail);
  }, []);

  useEffect(() => {
    async function initializeApp() {
      try {
        setIsLoading(true);
        log("APP_INIT", "STARTED", "Loading InvestIQ...");
        
        // Load stock list
        const stockList = await listStocks();
        setStocks(stockList);
        
        // Load stock data
        const initialData: Record<string, StockData> = {};
        for (const stockName of stockList) {
          try {
            const stockData = await db.load(`iq_stock_${stockName}`);
            if (stockData) {
              initialData[stockName] = stockData;
            }
          } catch (e) {
            console.warn(`Failed to load ${stockName}:`, e);
          }
        }
        
        setStockDataMap(initialData);
        
        log("APP_INIT", "SUCCESS", 
          `InvestIQ v${VERSION} • ${Object.keys(initialData).length} stocks loaded`
        );
        
      } catch (error) {
        console.error("App initialization failed:", error);
        log("APP_INIT", "ERROR", `Startup error: ${error}`);
      } finally {
        setIsLoading(false);
      }
    }

    initializeApp();
  }, [log]);

  const handleStocksChanged = useCallback(async (newList: string[]) => {
    setStocks(newList);
    
    const updated: Record<string, StockData> = {};
    for (const name of newList) {
      const stockData = await db.load(`iq_stock_${name}`);
      if (stockData) {
        updated[name] = stockDataMap[name] 
          ? { ...stockDataMap[name], ...stockData }
          : stockData;
      }
    }
    
    setStockDataMap(updated);
  }, [stockDataMap]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mx-auto mb-4"></div>
          <p className="text-slate-300">Loading InvestIQ...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-50">
      {/* Header */}
      <header className="bg-slate-900 border-b border-slate-800 p-4 sticky top-0 z-50 backdrop-blur-lg">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-xl font-bold text-slate-50">📊 InvestIQ</h1>
            <p className="text-xs text-slate-400">v{VERSION} • ML Engine • NSE & Global</p>
          </div>
          
          {/* Tab Navigation */}
          <div className="flex gap-1 bg-slate-800 rounded-lg p-1 border border-slate-700 overflow-x-auto">
            {TABS.map(([id, label]) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={`px-3 py-2 rounded-md text-sm font-medium transition-all whitespace-nowrap ${
                  tab === id
                    ? "bg-blue-600 text-white shadow-lg"
                    : "text-slate-300 hover:text-white hover:bg-slate-700"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          
          <div className="text-xs text-slate-400">
            {stocks.length} stock{stocks.length !== 1 ? "s" : ""} loaded
            {stocks.length > 0 && " •"}
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="p-6 max-w-7xl mx-auto">
        {tab === "data" && (
          <DataTab 
            onStocksChanged={handleStocksChanged} 
            log={log} 
          />
        )}
        {tab === "train" && (
          <TrainTab
            stocks={stocks}
            stockDataMap={stockDataMap}
            setStockDataMap={setStockDataMap}
            log={log}
            onStocksChanged={handleStocksChanged}
          />
        )}
        {tab === "predict" && (
          <PredictTab
            stocks={stocks}
            stockDataMap={stockDataMap}
          />
        )}
        {tab === "backtest" && (
          <BacktestTab
            stocks={stocks}
            stockDataMap={stockDataMap}
          />
        )}
        {tab === "portfolio" && (
          <PortfolioTab
            stocks={stocks}
            stockDataMap={stockDataMap}
            log={log}
          />
        )}
        {tab === "livelab" && (
          <LiveLabTab
            stocks={stocks}
            stockDataMap={stockDataMap}
            setStockDataMap={setStockDataMap}
            log={log}
            onStocksChanged={handleStocksChanged}
          />
        )}
      </main>
    </div>
  );
}