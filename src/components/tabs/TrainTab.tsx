'use client'

import { useState, useCallback } from 'react'
import { trainStockModel, TrainingOptions, TrainingProgress } from '@/lib/ml/training'
import { db } from '@/lib/database'
import type { StockData, TrainingResult } from '@/types'

interface TrainTabProps {
  stocks: string[];
  stockDataMap: Record<string, StockData>;
  setStockDataMap: (data: Record<string, StockData>) => void;
  log: (event: string, status: string, detail?: string) => void;
  onStocksChanged: (stocks: string[]) => void;
}

interface TrainingState {
  isTraining: boolean;
  progress: TrainingProgress | null;
  result: TrainingResult | null;
  error: string | null;
}

export default function TrainTab({
  stocks,
  stockDataMap,
  setStockDataMap,
  log,
  onStocksChanged
}: TrainTabProps) {
  const [selectedStock, setSelectedStock] = useState<string>(stocks[0] || '');
  const [trainingState, setTrainingState] = useState<Record<string, TrainingState>>({});
  const [trainedModels, setTrainedModels] = useState<Record<string, TrainingResult>>({});

  // Load existing training results
  const loadTrainingResults = useCallback(async () => {
    try {
      const results = await db.load('iq_train_results', {});
      setTrainedModels(results);
    } catch (error) {
      console.error('Failed to load training results:', error);
    }
  }, []);

  // Train model for specific stock and horizon
  const handleTrainModel = useCallback(async (stockName: string, horizon: number) => {
    const stockData = stockDataMap[stockName];
    if (!stockData) {
      log('TRAIN_MODEL', 'ERROR', `Stock data not found: ${stockName}`);
      return;
    }

    // Initialize training state
    setTrainingState(prev => ({
      ...prev,
      [stockName]: {
        isTraining: true,
        progress: null,
        result: null,
        error: null
      }
    }));

    try {
      log('TRAIN_MODEL', 'STARTED', `Training ${stockName} (${horizon}d horizon)`);

      const options: TrainingOptions = {
        horizon,
        deadbandFloor: horizon <= 30 ? 2.0 : horizon <= 60 ? 3.5 : 5.0,
        testSize: 0.2,
        nFolds: 5
      };

      const result = await trainStockModel(
        stockData,
        options,
        (progress) => {
          setTrainingState(prev => ({
            ...prev,
            [stockName]: {
              ...prev[stockName],
              progress
            }
          }));
        }
      );

      // Update training state with result
      setTrainingState(prev => ({
        ...prev,
        [stockName]: {
          isTraining: false,
          progress: null,
          result,
          error: null
        }
      }));

      // Update trained models
      setTrainedModels(prev => ({
        ...prev,
        [stockName]: result
      }));

      log('TRAIN_MODEL', 'SUCCESS', 
        `${stockName} trained: ${(result.btAcc * 100).toFixed(1)}% accuracy, ${result.nSamples} samples`
      );

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      
      setTrainingState(prev => ({
        ...prev,
        [stockName]: {
          isTraining: false,
          progress: null,
          result: null,
          error: errorMessage
        }
      }));

      log('TRAIN_MODEL', 'ERROR', `${stockName}: ${errorMessage}`);
    }
  }, [stockDataMap, log]);

  // Train all stocks
  const handleTrainAll = useCallback(async (horizon: number) => {
    const eligibleStocks = stocks.filter(stock => {
      const data = stockDataMap[stock];
      return data && data.rows.length >= horizon + 100;
    });

    for (const stock of eligibleStocks) {
      await handleTrainModel(stock, horizon);
      // Add delay between stocks to prevent overwhelming the system
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }, [stocks, stockDataMap, handleTrainModel]);

  const getStockStatus = (stockName: string) => {
    const data = stockDataMap[stockName];
    const training = trainingState[stockName];
    const trained = trainedModels[stockName];

    if (!data) return { status: 'no_data', color: 'bg-gray-600', text: 'No Data' };
    if (training?.isTraining) return { status: 'training', color: 'bg-blue-600', text: 'Training...' };
    if (training?.error) return { status: 'error', color: 'bg-red-600', text: 'Error' };
    if (trained) return { 
      status: 'trained', 
      color: 'bg-green-600', 
      text: `${(trained.btAcc * 100).toFixed(1)}%` 
    };
    if (data.rows.length < 200) return { 
      status: 'insufficient', 
      color: 'bg-yellow-600', 
      text: 'Low Data' 
    };
    return { status: 'ready', color: 'bg-blue-500', text: 'Ready' };
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-slate-50 mb-2">Model Training</h2>
        <p className="text-slate-400">
          Train ensemble ML models (LogReg + GBDT + Pattern) with walk-forward validation.
        </p>
      </div>

      {/* Quick Actions */}
      <div className="bg-slate-900 rounded-lg p-6">
        <h3 className="text-lg font-medium text-slate-200 mb-4">Quick Training</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {[30, 60, 90].map(horizon => (
            <div key={horizon} className="p-4 border border-slate-600 rounded-lg">
              <h4 className="font-medium text-slate-200 mb-2">{horizon}-Day Horizon</h4>
              <p className="text-sm text-slate-400 mb-3">
                {horizon <= 30 ? 'Short-term' : horizon <= 60 ? 'Medium-term' : 'Long-term'} predictions
              </p>
              <div className="flex gap-2">
                <button 
                  onClick={() => selectedStock && handleTrainModel(selectedStock, horizon)}
                  disabled={!selectedStock || trainingState[selectedStock]?.isTraining}
                  className="flex-1 px-3 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-600 
                           text-white text-sm rounded transition-colors"
                >
                  Train Selected
                </button>
                <button 
                  onClick={() => handleTrainAll(horizon)}
                  disabled={Object.values(trainingState).some(s => s.isTraining)}
                  className="flex-1 px-3 py-2 bg-green-600 hover:bg-green-700 disabled:bg-slate-600 
                           text-white text-sm rounded transition-colors"
                >
                  Train All
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Stock Selection & Status */}
      <div className="bg-slate-900 rounded-lg p-6">
        <h3 className="text-lg font-medium text-slate-200 mb-4">Stock Status</h3>
        
        {stocks.length === 0 ? (
          <div className="text-center py-8 text-slate-400">
            No stocks available. Please upload data first.
          </div>
        ) : (
          <div className="grid gap-3">
            {stocks.map((stock) => {
              const data = stockDataMap[stock];
              const training = trainingState[stock];
              const status = getStockStatus(stock);
              
              return (
                <div
                  key={stock}
                  className={`p-4 border rounded-lg cursor-pointer transition-colors ${
                    selectedStock === stock
                      ? 'border-blue-500 bg-blue-500/10'
                      : 'border-slate-600 hover:border-slate-500'
                  }`}
                  onClick={() => setSelectedStock(stock)}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-medium text-slate-200">{stock}</div>
                      <div className="text-sm text-slate-400">
                        {data?.rows.length || 0} rows • Last updated: {
                          data?._lastUpdated 
                            ? new Date(data._lastUpdated).toLocaleDateString()
                            : 'Unknown'
                        }
                      </div>
                      
                      {/* Training Progress */}
                      {training?.progress && (
                        <div className="mt-2">
                          <div className="text-xs text-slate-300 mb-1">
                            {training.progress.stage}: {training.progress.message}
                          </div>
                          <div className="w-full bg-slate-700 rounded-full h-2">
                            <div 
                              className="bg-blue-500 h-2 rounded-full transition-all"
                              style={{ width: `${training.progress.progress}%` }}
                            />
                          </div>
                        </div>
                      )}
                      
                      {/* Training Error */}
                      {training?.error && (
                        <div className="mt-2 text-xs text-red-400">
                          Error: {training.error}
                        </div>
                      )}
                    </div>
                    
                    <div className="flex items-center gap-2">
                      {training?.isTraining && (
                        <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-500"></div>
                      )}
                      <div className={`px-2 py-1 rounded text-xs text-white ${status.color}`}>
                        {status.text}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Training Results */}
      {Object.keys(trainedModels).length > 0 && (
        <div className="bg-slate-900 rounded-lg p-6">
          <h3 className="text-lg font-medium text-slate-200 mb-4">Training Results</h3>
          
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-slate-400 border-b border-slate-600">
                  <th className="text-left py-2">Stock</th>
                  <th className="text-left py-2">Horizon</th>
                  <th className="text-left py-2">Accuracy</th>
                  <th className="text-left py-2">Samples</th>
                  <th className="text-left py-2">UP/FLAT/DOWN</th>
                  <th className="text-left py-2">Trained</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(trainedModels).map(([stock, result]) => (
                  <tr key={stock} className="border-b border-slate-700">
                    <td className="py-2 text-slate-200">{result.stock}</td>
                    <td className="py-2 text-slate-300">{result.horizon}d</td>
                    <td className="py-2">
                      <span className={`font-medium ${
                        result.btAcc > 0.6 ? 'text-green-400' :
                        result.btAcc > 0.4 ? 'text-yellow-400' : 'text-red-400'
                      }`}>
                        {(result.btAcc * 100).toFixed(1)}%
                      </span>
                    </td>
                    <td className="py-2 text-slate-300">{result.nSamples}</td>
                    <td className="py-2 text-slate-300 text-xs">
                      {result.classBalance.up}/{result.classBalance.flat}/{result.classBalance.down}
                    </td>
                    <td className="py-2 text-slate-400 text-xs">
                      {new Date(result.createdAt).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Model Configuration */}
      <div className="bg-slate-900 rounded-lg p-6">
        <h3 className="text-lg font-medium text-slate-200 mb-4">Model Configuration</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div>
            <span className="text-slate-400">Algorithm:</span>
            <span className="ml-2 text-slate-200">Ensemble (LogReg + GBDT + Pattern)</span>
          </div>
          <div>
            <span className="text-slate-400">Features:</span>
            <span className="ml-2 text-slate-200">11 core indicators</span>
          </div>
          <div>
            <span className="text-slate-400">Validation:</span>
            <span className="ml-2 text-slate-200">5-fold walk-forward</span>
          </div>
          <div>
            <span className="text-slate-400">Labels:</span>
            <span className="ml-2 text-slate-200">UP/FLAT/DOWN (auto-calibrated)</span>
          </div>
        </div>
        
        <div className="mt-4 pt-4 border-t border-slate-600">
          <h4 className="font-medium text-slate-200 mb-2">Ensemble Weights</h4>
          <div className="flex gap-6 text-sm">
            <div>Logistic Regression: <span className="text-blue-400">25%</span></div>
            <div>Gradient Boosting: <span className="text-green-400">45%</span></div>
            <div>Pattern Matching: <span className="text-yellow-400">30%</span></div>
          </div>
        </div>
      </div>
    </div>
  );
}