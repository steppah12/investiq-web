// ML Models - Core training algorithms extracted from InvestIQ
import { FEAT_KEYS, FeatureRow, featureRowToVector } from './features'

// Simple Linear/Logistic Regression implementation
export class LogisticRegression {
  private weights: number[] = [];
  private intercept: number = 0;
  private learningRate: number = 0.01;
  private maxIterations: number = 1000;

  constructor(options: {
    learningRate?: number;
    maxIterations?: number;
    l2?: number;
  } = {}) {
    this.learningRate = options.learningRate || 0.01;
    this.maxIterations = options.maxIterations || 1000;
  }

  fit(X: number[][], y: number[], classWeights?: { positive: number; negative: number }) {
    const nFeatures = X[0].length;
    this.weights = new Array(nFeatures).fill(0);
    this.intercept = 0;

    const wPos = classWeights?.positive || 1;
    const wNeg = classWeights?.negative || 1;

    for (let iter = 0; iter < this.maxIterations; iter++) {
      let totalError = 0;

      for (let i = 0; i < X.length; i++) {
        const prediction = this.sigmoid(this.predict(X[i]));
        const error = y[i] - prediction;
        const weight = y[i] === 1 ? wPos : wNeg;

        // Update weights
        for (let j = 0; j < nFeatures; j++) {
          this.weights[j] += this.learningRate * error * X[i][j] * weight;
        }
        this.intercept += this.learningRate * error * weight;

        totalError += Math.abs(error);
      }

      // Early stopping if converged
      if (totalError / X.length < 0.01) break;
    }
  }

  predict(x: number[]): number {
    let result = this.intercept;
    for (let i = 0; i < x.length; i++) {
      result += this.weights[i] * x[i];
    }
    return result;
  }

  predictProba(x: number[]): number {
    return this.sigmoid(this.predict(x));
  }

  private sigmoid(x: number): number {
    return 1 / (1 + Math.exp(-Math.max(-500, Math.min(500, x))));
  }

  getWeights() {
    return {
      weights: [...this.weights],
      intercept: this.intercept
    };
  }

  setWeights(weights: number[], intercept: number) {
    this.weights = [...weights];
    this.intercept = intercept;
  }
}

// Simple GBDT implementation (Decision Trees + Gradient Boosting)
export class GradientBoosting {
  private trees: DecisionStump[] = [];
  private learningRate: number = 0.1;
  private nEstimators: number = 50;
  private maxDepth: number = 3;

  constructor(options: {
    learningRate?: number;
    nEstimators?: number;
    maxDepth?: number;
  } = {}) {
    this.learningRate = options.learningRate || 0.1;
    this.nEstimators = options.nEstimators || 50;
    this.maxDepth = options.maxDepth || 3;
  }

  fit(X: number[][], y: number[]) {
    // Initialize with mean prediction
    const meanY = y.reduce((a, b) => a + b, 0) / y.length;
    let predictions = new Array(y.length).fill(meanY);

    this.trees = [];

    for (let i = 0; i < this.nEstimators; i++) {
      // Calculate residuals
      const residuals = y.map((actual, idx) => actual - predictions[idx]);

      // Fit tree to residuals
      const tree = new DecisionStump();
      tree.fit(X, residuals);
      this.trees.push(tree);

      // Update predictions
      for (let j = 0; j < X.length; j++) {
        predictions[j] += this.learningRate * tree.predict(X[j]);
      }
    }
  }

  predict(x: number[]): number {
    let prediction = 0;
    for (const tree of this.trees) {
      prediction += this.learningRate * tree.predict(x);
    }
    return prediction;
  }

  predictProba(x: number[]): number {
    const logOdds = this.predict(x);
    return 1 / (1 + Math.exp(-logOdds));
  }
}

// Simple Decision Stump (1-level decision tree)
class DecisionStump {
  private featureIndex: number = 0;
  private threshold: number = 0;
  private leftValue: number = 0;
  private rightValue: number = 0;

  fit(X: number[][], y: number[]) {
    let bestMse = Infinity;
    const nFeatures = X[0].length;

    for (let feature = 0; feature < nFeatures; feature++) {
      const values = X.map(row => row[feature]).sort((a, b) => a - b);
      const uniqueValues = [...new Set(values)];

      for (const threshold of uniqueValues) {
        const leftIndices = X.map((row, idx) => row[feature] <= threshold ? idx : -1).filter(i => i >= 0);
        const rightIndices = X.map((row, idx) => row[feature] > threshold ? idx : -1).filter(i => i >= 0);

        if (leftIndices.length === 0 || rightIndices.length === 0) continue;

        const leftMean = leftIndices.reduce((sum, idx) => sum + y[idx], 0) / leftIndices.length;
        const rightMean = rightIndices.reduce((sum, idx) => sum + y[idx], 0) / rightIndices.length;

        // Calculate MSE
        let mse = 0;
        for (const idx of leftIndices) {
          mse += (y[idx] - leftMean) ** 2;
        }
        for (const idx of rightIndices) {
          mse += (y[idx] - rightMean) ** 2;
        }
        mse /= y.length;

        if (mse < bestMse) {
          bestMse = mse;
          this.featureIndex = feature;
          this.threshold = threshold;
          this.leftValue = leftMean;
          this.rightValue = rightMean;
        }
      }
    }
  }

  predict(x: number[]): number {
    return x[this.featureIndex] <= this.threshold ? this.leftValue : this.rightValue;
  }
}

// Ensemble model combining LogReg + GBDT + Pattern matching
export class EnsembleModel {
  private logReg: LogisticRegression;
  private gbdt: GradientBoosting;
  private weights = { logreg: 0.25, gbdt: 0.45, pattern: 0.30 };
  private isUpModel: boolean;

  constructor(isUpModel: boolean = true) {
    this.isUpModel = isUpModel;
    this.logReg = new LogisticRegression({
      learningRate: 0.01,
      maxIterations: 400,
    });
    this.gbdt = new GradientBoosting({
      learningRate: 0.1,
      nEstimators: 50,
      maxDepth: 3
    });
  }

  fit(features: FeatureRow[], labels: number[], classWeights?: { positive: number; negative: number }) {
    // Convert features to vectors
    const X = features.map(featureRowToVector);
    
    // Train individual models
    this.logReg.fit(X, labels, classWeights);
    this.gbdt.fit(X, labels);
  }

  predict(features: FeatureRow): number {
    const x = featureRowToVector(features);
    
    // Get predictions from each model
    const logRegProba = this.logReg.predictProba(x);
    const gbdtProba = this.gbdt.predictProba(x);
    const patternScore = this.calculatePatternScore(features);
    
    // Ensemble prediction
    return (
      this.weights.logreg * logRegProba +
      this.weights.gbdt * gbdtProba +
      this.weights.pattern * patternScore
    );
  }

  private calculatePatternScore(features: FeatureRow): number {
    // Simple pattern matching based on technical indicators
    let score = 0.5; // neutral baseline
    
    // RSI momentum
    if (features.rsi14 !== null) {
      if (this.isUpModel) {
        score += features.rsi14 < 30 ? 0.2 : features.rsi14 > 70 ? -0.1 : 0;
      } else {
        score += features.rsi14 > 70 ? 0.2 : features.rsi14 < 30 ? -0.1 : 0;
      }
    }
    
    // Price vs EMA trend
    if (features.pvE21 !== null && features.pvE50 !== null) {
      const trendScore = (features.pvE21 + features.pvE50) / 200; // normalize
      score += this.isUpModel ? trendScore : -trendScore;
    }
    
    // MACD signal
    if (features.macdAbove !== null) {
      score += this.isUpModel ? features.macdAbove * 0.1 : -features.macdAbove * 0.1;
    }
    
    return Math.max(0, Math.min(1, score));
  }

  getModelWeights() {
    return {
      logistic: this.logReg.getWeights(),
      gbdt: 'trees', // GBDT weights are complex tree structures
      ensemble_weights: this.weights,
      is_up_model: this.isUpModel
    };
  }
}

// Label generation for 3-class classification
export function generateLabels(
  rows: any[],
  horizon: number,
  deadband: number = 2.0
): { labels: number[], labelCounts: { up: number, flat: number, down: number } } {
  const labels: number[] = [];
  let upCount = 0, flatCount = 0, downCount = 0;

  for (let i = 0; i < rows.length - horizon; i++) {
    if (rows[i]._boundary || rows[i + horizon]._boundary) {
      labels.push(-1); // Skip boundary rows
      continue;
    }

    const currentPrice = rows[i].close;
    const futurePrice = rows[i + horizon].close;
    const returnPct = ((futurePrice - currentPrice) / currentPrice) * 100;

    let label: number;
    if (returnPct > deadband) {
      label = 2; // UP
      upCount++;
    } else if (returnPct < -deadband) {
      label = 0; // DOWN
      downCount++;
    } else {
      label = 1; // FLAT
      flatCount++;
    }

    labels.push(label);
  }

  return {
    labels,
    labelCounts: { up: upCount, flat: flatCount, down: downCount }
  };
}

// Class balancing for binary classification
export function prepareBalancedBinary(
  features: FeatureRow[],
  labels: number[],
  targetClass: number
): {
  X: FeatureRow[],
  y: number[],
  classWeights: { positive: number, negative: number }
} {
  const positiveIndices = labels.map((label, idx) => label === targetClass ? idx : -1).filter(i => i >= 0);
  const negativeIndices = labels.map((label, idx) => label !== targetClass && label >= 0 ? idx : -1).filter(i => i >= 0);

  if (positiveIndices.length === 0) {
    // Degenerate case - create synthetic examples
    const syntheticCount = Math.min(negativeIndices.length, 50);
    const syntheticIndices = negativeIndices.slice(0, syntheticCount);
    
    return {
      X: [...positiveIndices, ...negativeIndices].map(i => features[i]),
      y: [...Array(syntheticCount).fill(1), ...Array(negativeIndices.length).fill(0)],
      classWeights: { positive: 1, negative: 1 }
    };
  }

  // Calculate class weights for balanced training
  const total = positiveIndices.length + negativeIndices.length;
  const positiveWeight = total / (2 * positiveIndices.length);
  const negativeWeight = total / (2 * negativeIndices.length);

  const X = [...positiveIndices, ...negativeIndices].map(i => features[i]);
  const y = [...Array(positiveIndices.length).fill(1), ...Array(negativeIndices.length).fill(0)];

  return {
    X,
    y,
    classWeights: { positive: positiveWeight, negative: negativeWeight }
  };
}