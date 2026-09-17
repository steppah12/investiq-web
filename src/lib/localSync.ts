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

// Tracks in-flight background writes to Supabase. Exists specifically so
// the app can warn before the user closes/navigates away mid-write —
// mirrorSaveToSupabase is fire-and-forget by design (keeps the UI fast),
// but that means a write genuinely can be lost if the tab closes before
// it finishes. This makes that risk visible instead of silent.
let pendingWrites = 0
let hydrationFailed = false

export function hasPendingWrites(): boolean {
  return pendingWrites > 0
}

export function didHydrationFail(): boolean {
  return hydrationFailed
}

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
    hydrationFailed = false
  } catch (e) {
    console.warn('hydrateLocalStorageFromSupabase failed — starting from local data only', e)
    hydrationFailed = true
  }
}

export function mirrorSaveToSupabase(key: string, value: any): void {
  pendingWrites++
  remoteDb
    .save(key, value)
    .catch((e) => console.warn('mirror save failed', key, e))
    .finally(() => {
      pendingWrites--
    })
}

export function mirrorRemoveFromSupabase(key: string): void {
  pendingWrites++
  remoteDb
    .remove(key)
    .catch((e) => console.warn('mirror remove failed', key, e))
    .finally(() => {
      pendingWrites--
    })
}
