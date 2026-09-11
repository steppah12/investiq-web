// Training System - Core ML training pipeline
import { buildAllFeatures, calibrateDeadband, normalizeFeatures, FEAT_KEYS } from './features'
import { EnsembleModel, generateLabels, prepareBalancedBinary } from './models'
import { db } from '@/lib/database'
import type { StockData, TrainingResult, ModelWeights } from '@/types'

export interface TrainingOptions {
  horizon: number;
  deadbandFloor: number;
  testSize: number;
  nFolds: number;
}

export interface TrainingProgress {
  stage: string;
  progress: number;
  message: string;
}

// Main training function
export async function trainStockModel(
  stockData: StockData,
  options: TrainingOptions = {
    horizon: 30,
    deadbandFloor: 2.0,
    testSize: 0.2,
    nFolds: 5
  },
  onProgress?: (progress: TrainingProgress) => void
): Promise<TrainingResult> {
  
  const { rows, name: stockName } = stockData;
  const { horizon, deadbandFloor, testSize, nFolds } = options;

  if (rows.length < horizon + 100) {
    throw new Error(`Insufficient data: need at least ${horizon + 100} rows, got ${rows.length}`);
  }

  onProgress?.({ stage: 'preparation', progress: 10, message: 'Preparing data and features...' });

  // Auto-calibrate deadband
  const autoBand = calibrateDeadband(rows, horizon, 0.30);
  const effectiveBand = Math.max(deadbandFloor, autoBand);

  // Build features
  const features = buildAllFeatures(rows, null, stockName);
  const { normalized, stats } = normalizeFeatures(features);

  // Generate labels
  const { labels, labelCounts } = generateLabels(rows, horizon, effectiveBand);

  onProgress?.({ stage: 'labeling', progress: 20, message: `Generated labels: ${labelCounts.up} UP, ${labelCounts.flat} FLAT, ${labelCounts.down} DOWN` });

  // Walk-forward validation
  const foldSize = Math.floor((labels.length - horizon) / nFolds);
  const foldResults = [];
  
  let totalCorrect = 0;
  let totalPredictions = 0;

  onProgress?.({ stage: 'training', progress: 30, message: 'Starting walk-forward validation...' });

  for (let fold = 0; fold < nFolds; fold++) {
    const progressPct = 30 + (fold / nFolds) * 50;
    onProgress?.({ 
      stage: 'training', 
      progress: progressPct, 
      message: `Training fold ${fold + 1}/${nFolds}...` 
    });

    // Split data for this fold
    const trainStart = 0;
    const trainEnd = foldSize * (fold + 1);
    const testStart = trainEnd;
    const testEnd = Math.min(testStart + foldSize, labels.length);

    if (testEnd <= testStart) continue;

    // Training data
    const trainFeatures = normalized.slice(trainStart, trainEnd);
    const trainLabels = labels.slice(trainStart, trainEnd);

    // Test data  
    const testFeatures = normalized.slice(testStart, testEnd);
    const testLabels = labels.slice(testStart, testEnd);

    // Train UP and DOWN models
    const { upModel, downModel } = await trainBinaryModels(
      trainFeatures, 
      trainLabels, 
      onProgress
    );

    // Evaluate on test set
    const { accuracy, predictions } = evaluateModels(
      upModel, 
      downModel, 
      testFeatures, 
      testLabels,
      0.55 // confidence threshold
    );

    foldResults.push({
      fold: fold + 1,
      trainSize: trainFeatures.length,
      testSize: testFeatures.length,
      accuracy,
      predictions: predictions.length
    });

    totalCorrect += predictions.filter(p => p.correct).length;
    totalPredictions += predictions.length;
  }

  const overallAccuracy = totalPredictions > 0 ? totalCorrect / totalPredictions : 0;

  onProgress?.({ stage: 'saving', progress: 90, message: 'Saving model weights...' });

  // Train final model on all data
  const finalFeatures = normalized.slice(0, labels.length);
  const finalLabels = labels.slice(0, labels.length);
  const { upModel: finalUpModel, downModel: finalDownModel } = await trainBinaryModels(
    finalFeatures,
    finalLabels,
    onProgress
  );

  // Save model weights
  const modelWeights: ModelWeights = {
    stock: stockName,
    horizon,
    weights: {
      upModel: finalUpModel.getModelWeights(),
      downModel: finalDownModel.getModelWeights(),
      normalizationStats: stats,
      deadband: effectiveBand,
      threshold: 0.55,
      featureKeys: FEAT_KEYS
    },
    accuracy: overallAccuracy,
    createdAt: new Date().toISOString(),
    version: '9.5.31'
  };

  await db.save(`iq_weights_${stockName}`, modelWeights);

  onProgress?.({ stage: 'complete', progress: 100, message: 'Training complete!' });

  // Return training result
  const result: TrainingResult = {
    stock: stockName,
    horizon,
    btAcc: overallAccuracy,
    inSampleAcc: 0, // TODO: Calculate in-sample accuracy
    nSamples: totalPredictions,
    classBalance: {
      up: labelCounts.up,
      flat: labelCounts.flat,
      down: labelCounts.down
    },
    features: FEAT_KEYS,
    createdAt: new Date().toISOString()
  };

  // Save training result
  await db.save('iq_train_results', { [stockName]: result });

  return result;
}

// Train binary UP/DOWN models
async function trainBinaryModels(
  features: any[],
  labels: number[],
  onProgress?: (progress: TrainingProgress) => void
) {
  // Prepare UP model data
  const upData = prepareBalancedBinary(features, labels, 2); // target class UP = 2
  const upModel = new EnsembleModel(true);
  upModel.fit(upData.X, upData.y, upData.classWeights);

  // Prepare DOWN model data  
  const downData = prepareBalancedBinary(features, labels, 0); // target class DOWN = 0
  const downModel = new EnsembleModel(false);
  downModel.fit(downData.X, downData.y, downData.classWeights);

  return { upModel, downModel };
}

// Evaluate models on test set
function evaluateModels(
  upModel: EnsembleModel,
  downModel: EnsembleModel,
  testFeatures: any[],
  testLabels: number[],
  threshold: number = 0.55
) {
  const predictions = [];
  let correct = 0;

  for (let i = 0; i < testFeatures.length; i++) {
    if (testLabels[i] < 0) continue; // Skip boundary rows

    const probUp = upModel.predict(testFeatures[i]);
    const probDown = downModel.predict(testFeatures[i]);

    let prediction = 'NEUTRAL';
    let confidence = 0;

    if (probUp > threshold && probUp > probDown) {
      prediction = 'UP';
      confidence = probUp;
    } else if (probDown > threshold && probDown > probUp) {
      prediction = 'DOWN'; 
      confidence = probDown;
    }

    // Determine actual direction
    let actual = 'FLAT';
    if (testLabels[i] === 2) actual = 'UP';
    else if (testLabels[i] === 0) actual = 'DOWN';

    const isCorrect = prediction === actual || (prediction === 'NEUTRAL' && actual === 'FLAT');
    if (isCorrect) correct++;

    predictions.push({
      predicted: prediction,
      actual,
      confidence,
      correct: isCorrect
    });
  }

  return {
    accuracy: predictions.length > 0 ? correct / predictions.length : 0,
    predictions
  };
}

// Backtesting function for historical validation
export async function runBacktest(
  stockData: StockData,
  modelWeights: ModelWeights,
  startDate?: string,
  endDate?: string
): Promise<{
  accuracy: number;
  trades: number;
  returns: number[];
  predictions: any[];
}> {
  const { rows } = stockData;
  
  // Filter date range if specified
  let testRows = rows;
  if (startDate) {
    testRows = testRows.filter(r => r.date >= startDate);
  }
  if (endDate) {
    testRows = testRows.filter(r => r.date <= endDate);
  }

  if (testRows.length < modelWeights.horizon + 50) {
    throw new Error('Insufficient data for backtesting');
  }

  // Rebuild features for test period
  const features = buildAllFeatures(testRows);
  const { normalized } = normalizeFeatures(features);

  // Load model (this would reconstruct the trained models)
  // For now, we'll simulate predictions
  const predictions = [];
  const returns = [];
  let correct = 0;

  for (let i = 50; i < normalized.length - modelWeights.horizon; i++) {
    // Simulate model prediction (in real implementation, use saved model weights)
    const mockPrediction = Math.random() > 0.5 ? 'UP' : 'DOWN';
    const confidence = 0.6 + Math.random() * 0.3;

    // Calculate actual return
    const currentPrice = testRows[i].close;
    const futurePrice = testRows[i + modelWeights.horizon].close;
    const actualReturn = ((futurePrice - currentPrice) / currentPrice) * 100;

    const actualDirection = actualReturn > 2 ? 'UP' : actualReturn < -2 ? 'DOWN' : 'FLAT';
    const isCorrect = mockPrediction === actualDirection;

    if (isCorrect) correct++;

    predictions.push({
      date: testRows[i].date,
      predicted: mockPrediction,
      actual: actualDirection,
      confidence,
      actualReturn,
      correct: isCorrect
    });

    if (mockPrediction !== 'NEUTRAL') {
      returns.push(actualReturn);
    }
  }

  return {
    accuracy: predictions.length > 0 ? correct / predictions.length : 0,
    trades: returns.length,
    returns,
    predictions
  };
}

// Batch training for multiple stocks
export async function trainMultipleStocks(
  stockDataMap: Record<string, StockData>,
  options: TrainingOptions,
  onProgress?: (stock: string, progress: TrainingProgress) => void
): Promise<Record<string, TrainingResult>> {
  const results: Record<string, TrainingResult> = {};
  const stocks = Object.keys(stockDataMap);

  for (let i = 0; i < stocks.length; i++) {
    const stockName = stocks[i];
    const stockData = stockDataMap[stockName];

    try {
      const result = await trainStockModel(
        stockData,
        options,
        (progress) => onProgress?.(stockName, progress)
      );
      results[stockName] = result;
    } catch (error) {
      console.error(`Training failed for ${stockName}:`, error);
      // Continue with other stocks
    }
  }

  return results;
}