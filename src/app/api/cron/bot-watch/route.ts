// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase/client'

// Dead-man's switch for the Kali bot. The bot's own watchdog (bot/health-check.mjs) writes a
// bot_health row at 06:35, 10:35 and 16:35 EAT on weekdays, but it cannot report that the machine
// itself is off. This route runs on Vercel, outside that machine, and alerts when no bot_health
// row has appeared in the last STALE_HOURS hours. Vercel Cron calls it via GET with
// `Authorization: Bearer <CRON_SECRET>`, same as /api/cron/daily-update.

const STALE_HOURS = 3

async function notify(text: string) {
  const url = process.env.ALERT_WEBHOOK_URL
  if (!url) return 'no ALERT_WEBHOOK_URL set, nothing sent'
  try {
    const res = await fetch(url, {
      method: 'POST',
      body: text,
      headers: { Title: 'InvestIQ bot SILENT', Priority: 'high', Tags: 'warning' },
      signal: AbortSignal.timeout(15000),
    })
    return 'alert sent, HTTP ' + res.status
  } catch (e) {
    return 'alert failed: ' + (e instanceof Error ? e.message : 'unknown error')
  }
}

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret || request.headers.get('authorization') !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!supabaseAdmin) {
    return NextResponse.json({ error: 'Supabase admin client not configured' }, { status: 500 })
  }

  const since = new Date(Date.now() - STALE_HOURS * 3600 * 1000).toISOString()
  const { data, error } = await supabaseAdmin
    .from('bot_health')
    .select('checked_at,status')
    .gte('checked_at', since)
    .order('checked_at', { ascending: false })
    .limit(1)

  if (error) {
    await supabaseAdmin.from('audit_log').insert({ event: 'BOT_WATCH', status: 'ERROR', detail: 'bot_health read failed: ' + error.message })
    return NextResponse.json({ error: 'bot_health read failed', details: error.message }, { status: 500 })
  }

  if (!data || data.length === 0) {
    const msg = `No bot_health row in the last ${STALE_HOURS} hours (checked ${new Date().toISOString()}). The bot machine may be off, asleep or offline.`
    const result = await notify(msg)
    await supabaseAdmin.from('audit_log').insert({ event: 'BOT_WATCH', status: 'ALERT', detail: msg + ' ' + result })
    return NextResponse.json({ silent: true, notify: result })
  }

  const last = data[0]
  await supabaseAdmin.from('audit_log').insert({
    event: 'BOT_WATCH',
    status: 'OK',
    detail: `last bot_health row ${last.checked_at} (${last.status})`,
  })
  return NextResponse.json({ silent: false, lastRow: last })
}
