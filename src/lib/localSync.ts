// Bridges the app's existing localStorage-based `db` object (inside
// InvestIQApp.tsx) with the real Supabase-backed store in database.ts.
//
// Pattern: "sync-first, hydrate-and-mirror" — deliberately NOT a rewrite of
// every localStorage call site (too risky in a 9000-line file). Instead:
//   1. On app startup, pull every row down from Supabase into localStorage
//      (see hydrateLocalStorageFromSupabase, called from page.tsx before the
//      app mounts).
//   2. Every time the app writes to localStorage, also fire off a
//      background write to Supabase (see mirrorSaveToSupabase /
//      mirrorRemoveFromSupabase, called from the local db object in
//      InvestIQApp.tsx).
// The app's own read/write logic never changes — it keeps reading and
// writing localStorage exactly as before, synchronously.
import { db as remoteDb } from './database'

export async function hydrateLocalStorageFromSupabase(): Promise<void> {
  if (typeof window === 'undefined') return
  try {
    const entries = await remoteDb.allEntries()
    for (const { key, value } of entries) {
      try {
        localStorage.setItem(key, JSON.stringify(value))
      } catch (e) {
        // Likely a quota error on one oversized key — skip it, don't abort
        // hydration of everything else.
        console.warn('hydrate: failed to write key', key, e)
      }
    }
  } catch (e) {
    console.warn('hydrateLocalStorageFromSupabase failed — starting from local data only', e)
  }
}

export function mirrorSaveToSupabase(key: string, value: any): void {
  remoteDb.save(key, value).catch((e) => console.warn('mirror save failed', key, e))
}

export function mirrorRemoveFromSupabase(key: string): void {
  remoteDb.remove(key).catch((e) => console.warn('mirror remove failed', key, e))
}
