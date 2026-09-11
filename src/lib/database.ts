// Database abstraction layer - migrated from localStorage to Supabase
import { supabase } from './supabase/client'
import type { 
  StockData, 
  StockRow, 
  ModelWeights, 
  TrainingResult, 
  PortfolioEntry, 
  AuditLogEntry, 
  MacroData 
} from '@/types'

const MAX_STORAGE_BYTES = 50_000_000; // 50MB limit for Supabase

export const db = {
  async save(key: string, value: any): Promise<boolean> {
    try {
      const serialized = JSON.stringify(value);
      if (serialized.length > MAX_STORAGE_BYTES) {
        console.warn(`db.save: ${key} too large`);
        return false;
      }

      // Handle different key types
      if (key.startsWith('iq_stock_')) {
        const stockName = key.replace('iq_stock_', '');
        const { error } = await supabase
          .from('stocks')
          .upsert({
            name: stockName,
            data: value.rows || [],
            last_updated: new Date().toISOString()
          });
        return !error;
      }

      if (key.startsWith('iq_weights_')) {
        const stockName = key.replace('iq_weights_', '');
        const { error } = await supabase
          .from('model_weights')
          .upsert({
            stock_name: stockName,
            horizon: value.horizon || 30,
            weights: value,
            accuracy: value.accuracy || 0,
            version: '9.5.31'
          });
        return !error;
      }

      if (key === 'iq_train_results') {
        // Save training results
        for (const [stockName, result] of Object.entries(value)) {
          await supabase
            .from('training_results')
            .upsert({
              stock_name: stockName,
              result_data: result
            });
        }
        return true;
      }

      if (key === 'iq_portfolio') {
        // Clear existing portfolio and insert new entries
        await supabase.from('portfolio').delete().neq('id', '');
        
        for (const entry of value as PortfolioEntry[]) {
          await supabase
            .from('portfolio')
            .insert({
              asset: entry.asset,
              quantity: entry.qty,
              buy_price: entry.buyPrice,
              current_price: entry.currentPrice
            });
        }
        return true;
      }

      if (key === 'iq_macro') {
        const { error } = await supabase
          .from('macro_data')
          .upsert({
            date: new Date().toISOString().split('T')[0],
            ...value
          });
        return !error;
      }

      // Generic key-value store (for other settings)
      // We'll use a simple JSON column in stocks table or create a settings table
      console.warn(`Unhandled key type: ${key}`);
      return false;

    } catch (e) {
      console.warn("db.save failed", key, e);
      return false;
    }
  },

  async load(key: string, fallback: any = null): Promise<any> {
    try {
      if (key.startsWith('iq_stock_')) {
        const stockName = key.replace('iq_stock_', '');
        const { data, error } = await supabase
          .from('stocks')
          .select('*')
          .eq('name', stockName)
          .single();
        
        if (error || !data) return fallback;
        
        return {
          name: data.name,
          rows: data.data,
          _lastUpdated: data.last_updated
        };
      }

      if (key.startsWith('iq_weights_')) {
        const stockName = key.replace('iq_weights_', '');
        const { data, error } = await supabase
          .from('model_weights')
          .select('*')
          .eq('stock_name', stockName)
          .order('created_at', { ascending: false })
          .limit(1)
          .single();
        
        return error || !data ? fallback : data.weights;
      }

      if (key === 'iq_train_results') {
        const { data, error } = await supabase
          .from('training_results')
          .select('*')
          .order('created_at', { ascending: false });
        
        if (error || !data) return fallback;
        
        const results: Record<string, any> = {};
        data.forEach(row => {
          results[row.stock_name] = row.result_data;
        });
        return results;
      }

      if (key === 'iq_portfolio') {
        const { data, error } = await supabase
          .from('portfolio')
          .select('*')
          .order('added_at', { ascending: false });
        
        if (error || !data) return fallback;
        
        return data.map(row => ({
          asset: row.asset,
          qty: row.quantity,
          buyPrice: row.buy_price,
          currentPrice: row.current_price,
          addedAt: row.added_at
        }));
      }

      if (key === 'iq_macro') {
        const { data, error } = await supabase
          .from('macro_data')
          .select('*')
          .order('date', { ascending: false })
          .limit(1)
          .single();
        
        if (error || !data) return fallback;
        
        return {
          cbk_rate: data.cbk_rate,
          inflation: data.inflation,
          usd_kes: data.usd_kes,
          gdp_growth: data.gdp_growth
        };
      }

      return fallback;
    } catch (e) {
      console.warn("db.load failed", key, e);
      return fallback;
    }
  },

  async remove(key: string): Promise<void> {
    try {
      if (key.startsWith('iq_stock_')) {
        const stockName = key.replace('iq_stock_', '');
        await supabase.from('stocks').delete().eq('name', stockName);
        return;
      }

      if (key.startsWith('iq_weights_')) {
        const stockName = key.replace('iq_weights_', '');
        await supabase.from('model_weights').delete().eq('stock_name', stockName);
        return;
      }

      // Handle other key types as needed
      console.warn(`Remove not implemented for key: ${key}`);
    } catch (e) {
      console.warn("db.remove failed", key, e);
    }
  },

  async keys(prefix: string = ""): Promise<string[]> {
    try {
      if (prefix === 'iq_stock_') {
        const { data, error } = await supabase
          .from('stocks')
          .select('name');
        
        if (error || !data) return [];
        return data.map(row => `iq_stock_${row.name}`);
      }

      if (prefix === 'iq_weights_') {
        const { data, error } = await supabase
          .from('model_weights')
          .select('stock_name');
        
        if (error || !data) return [];
        const uniqueStocks = Array.from(new Set(data.map((row: any) => row.stock_name)));
        return uniqueStocks.map(name => `iq_weights_${name}`);
      }

      // For other prefixes, return empty for now
      return [];
    } catch (e) {
      console.warn("db.keys failed", prefix, e);
      return [];
    }
  }
};

// Helper functions for compatibility with original code
export async function listStocks(): Promise<string[]> {
  const { data, error } = await supabase
    .from('stocks')
    .select('name')
    .order('name');
  
  if (error || !data) return [];
  return data.map(row => row.name);
}

export async function loadStockData(name: string): Promise<StockData | null> {
  const data = await db.load(`iq_stock_${name}`);
  return data;
}

export async function saveStockData(name: string, stockData: StockData): Promise<boolean> {
  return await db.save(`iq_stock_${name}`, stockData);
}

export async function deleteStock(name: string): Promise<void> {
  // Delete from all related tables
  await Promise.all([
    supabase.from('stocks').delete().eq('name', name),
    supabase.from('model_weights').delete().eq('stock_name', name),
    supabase.from('training_results').delete().eq('stock_name', name),
    supabase.from('predictions').delete().eq('stock_name', name),
  ]);
}

export function hasAdminRole(): boolean {
  // For now, always return true. Add proper auth later
  return true;
}