// @ts-nocheck
// Database abstraction layer — backed by a generic Supabase `kv` table.
//
// Every key the app saves (iq_stock_*, iq_weights_*, iq_lhist_*, iq_events,
// iq_deadband, iq_train_results, iq_portfolio, iq_macro, etc.) is stored as a
// row in `kv(key TEXT PK, value JSONB)`. This mirrors exactly what the old
// localStorage-based db object did, so no key is ever "unhandled" — see
// supabase-migration/001_add_kv_table.sql for the table definition.
import { supabase } from './supabase/client'
import type { StockData } from '@/types'

const MAX_STORAGE_BYTES = 50_000_000

function isSupabaseAvailable(): boolean {
  return supabase !== null && supabase !== undefined
}

export const db = {
  async save(key: string, value: any): Promise<boolean> {
    if (!isSupabaseAvailable()) {
      console.warn('Supabase not available, save skipped:', key)
      return false
    }
    try {
      const serialized = JSON.stringify(value)
      if (serialized.length > MAX_STORAGE_BYTES) {
        console.warn(`db.save: ${key} too large`)
        return false
      }
      const { error } = await supabase
        .from('kv')
        .upsert({ key, value, updated_at: new Date().toISOString() })
      if (error) {
        console.warn('db.save failed', key, error)
        return false
      }
      return true
    } catch (e) {
      console.warn('db.save failed', key, e)
      return false
    }
  },

  async load(key: string, fallback: any = null): Promise<any> {
    if (!isSupabaseAvailable()) {
      console.warn('Supabase not available, load skipped:', key)
      return fallback
    }
    try {
      const { data, error } = await supabase
        .from('kv')
        .select('value')
        .eq('key', key)
        .maybeSingle()

      if (error || !data) return fallback
      return data.value
    } catch (e) {
      console.warn('db.load failed', key, e)
      return fallback
    }
  },

  async remove(key: string): Promise<void> {
    if (!isSupabaseAvailable()) return
    try {
      await supabase.from('kv').delete().eq('key', key)
    } catch (e) {
      console.warn('db.remove failed', key, e)
    }
  },

  async keys(prefix: string = ''): Promise<string[]> {
    if (!isSupabaseAvailable()) return []
    try {
      let query = supabase.from('kv').select('key')
      if (prefix) query = query.like('key', `${prefix}%`)
      const { data, error } = await query
      if (error || !data) return []
      return data.map((row: any) => row.key)
    } catch (e) {
      console.warn('db.keys failed', prefix, e)
      return []
    }
  },

  // Fetch every key+value pair. Used by localSync.ts to hydrate localStorage
  // on app startup.
  async allEntries(): Promise<{ key: string; value: any }[]> {
    if (!isSupabaseAvailable()) return []
    try {
      const { data, error } = await supabase.from('kv').select('key, value')
      if (error || !data) return []
      return data
    } catch (e) {
      console.warn('db.allEntries failed', e)
      return []
    }
  },
}

// ── Compatibility helpers (used by DataTab.tsx / TrainTab.tsx) ──────────────
// Kept so those components keep working; now backed by the kv table too.
export async function listStocks(): Promise<string[]> {
  const stockKeys = await db.keys('iq_stock_')
  return stockKeys.map((k) => k.replace('iq_stock_', ''))
}

export async function loadStockData(name: string): Promise<StockData | null> {
  return await db.load(`iq_stock_${name}`)
}

export async function saveStockData(name: string, stockData: StockData): Promise<boolean> {
  return await db.save(`iq_stock_${name}`, stockData)
}

export async function deleteStock(name: string): Promise<void> {
  const safeName = name.replace(/\s+/g, '_')
  await Promise.all([
    db.remove(`iq_stock_${name}`),
    db.remove(`iq_weights_${safeName}`),
    db.remove(`iq_lhist_${safeName}`),
    db.remove(`iq_ablation_${safeName}`),
  ])
}

export function hasAdminRole(): boolean {
  // For now, always return true. Add proper auth later.
  return true
}
