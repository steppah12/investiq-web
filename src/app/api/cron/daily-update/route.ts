// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase/client'
import { fetchAndStoreAllTrackedStocks } from '@/lib/nseSync'

// Vercel Cron triggers this via GET on the schedule in vercel.json.
// If you've set a CRON_SECRET env var in your Vercel project, Vercel
// automatically sends it as `Authorization: Bearer <CRON_SECRET>` on cron
// calls — make sure that env var is actually set, or every cron run will
// 401. Manual calls (e.g. from the UI, or curl) need the same header.

export async function GET(request: NextRequest) {
  try {
    console.log('Starting daily NSE data update...')

    const authHeader = request.headers.get('authorization')
    const cronSecret = process.env.CRON_SECRET || 'dev-secret'

    if (authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { priceResults, liveLabResults, liveLabError } = await fetchAndStoreAllTrackedStocks()

    const successCount = priceResults.filter((r) => r.status === 'updated').length
    const errorCount = priceResults.filter((r) => r.status === 'error').length
    const liveLabCycles = (liveLabResults || []).reduce((sum, r) => sum + (r.cyclesRun?.length || 0), 0)

    console.log(
      `Daily update completed: ${successCount} price updates, ${errorCount} errors, ${liveLabCycles} Live Lab cycles run`
    )

    if (supabaseAdmin) {
      await supabaseAdmin.from('audit_log').insert({
        event: 'DAILY_UPDATE',
        status: errorCount > 0 || liveLabError ? 'PARTIAL_SUCCESS' : 'SUCCESS',
        detail: `${successCount} price updates, ${errorCount} errors, ${liveLabCycles} Live Lab cycles${liveLabError ? ` — Live Lab error: ${liveLabError}` : ''}`,
      })
    }

    return NextResponse.json({
      success: true,
      summary: { total: priceResults.length, updated: successCount, errors: errorCount, liveLabCycles },
      priceResults,
      liveLabResults,
      liveLabError,
    })
  } catch (error) {
    console.error('Daily update failed:', error)

    if (supabaseAdmin) {
      await supabaseAdmin.from('audit_log').insert({
        event: 'DAILY_UPDATE',
        status: 'ERROR',
        detail: error instanceof Error ? error.message : 'Unknown error',
      })
    }

    return NextResponse.json(
      { error: 'Daily update failed', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}

// For manual triggers via POST (e.g. a "Refresh now" button in the UI)
export async function POST(request: NextRequest) {
  return GET(request)
}
