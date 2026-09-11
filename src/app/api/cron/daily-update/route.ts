// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase/client'

// This endpoint can be called by Vercel Cron or external cron services
// To set up on Vercel: add vercel.json cron configuration

export async function GET(request: NextRequest) {
  try {
    console.log('Starting daily NSE data update...');
    
    // Verify this is a legitimate cron call
    const authHeader = request.headers.get('authorization');
    const cronSecret = process.env.CRON_SECRET || 'dev-secret';
    
    if (authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }
    
    // Get list of stocks that need updating
    const { data: stocks, error } = await supabaseAdmin
      .from('stocks')
      .select('name, ticker, last_updated')
      .order('last_updated', { ascending: true });
    
    if (error) {
      throw error;
    }
    
    const results = [];
    const today = new Date().toISOString().split('T')[0];
    
    for (const stock of stocks || []) {
      try {
        // Check if already updated today
        const lastUpdate = stock.last_updated?.split('T')[0];
        if (lastUpdate === today) {
          results.push({
            stock: stock.name,
            status: 'skipped',
            reason: 'already_updated_today'
          });
          continue;
        }
        
        // Fetch fresh data (this would call actual NSE API in production)
        const response = await fetch(
          `${process.env.VERCEL_URL || 'http://localhost:3000'}/api/nse/fetch?ticker=${stock.ticker}`,
          {
            headers: {
              'Authorization': `Bearer ${cronSecret}`
            }
          }
        );
        
        if (response.ok) {
          results.push({
            stock: stock.name,
            status: 'updated',
            timestamp: new Date().toISOString()
          });
        } else {
          throw new Error(`HTTP ${response.status}`);
        }
        
        // Rate limiting - don't overwhelm NSE servers
        await new Promise(resolve => setTimeout(resolve, 2000));
        
      } catch (error) {
        console.error(`Failed to update ${stock.name}:`, error);
        results.push({
          stock: stock.name,
          status: 'error',
          error: error instanceof Error ? error.message : 'Unknown error'
        });
        
        // Log the error
        await supabaseAdmin
          .from('nse_fetch_log')
          .insert({
            stock_ticker: stock.ticker || stock.name,
            fetch_date: today,
            status: 'ERROR',
            error_message: error instanceof Error ? error.message : 'Unknown error'
          });
      }
    }
    
    // Log the daily update summary
    const successCount = results.filter(r => r.status === 'updated').length;
    const errorCount = results.filter(r => r.status === 'error').length;
    const skippedCount = results.filter(r => r.status === 'skipped').length;
    
    console.log(`Daily update completed: ${successCount} updated, ${errorCount} errors, ${skippedCount} skipped`);
    
    // Store summary in audit log
    await supabaseAdmin
      .from('audit_log')
      .insert({
        event: 'DAILY_UPDATE',
        status: errorCount > 0 ? 'PARTIAL_SUCCESS' : 'SUCCESS',
        detail: `${successCount} updated, ${errorCount} errors, ${skippedCount} skipped`
      });
    
    return NextResponse.json({
      success: true,
      summary: {
        total: results.length,
        updated: successCount,
        errors: errorCount,
        skipped: skippedCount
      },
      results
    });
    
  } catch (error) {
    console.error('Daily update failed:', error);
    
    // Log the failure
    await supabaseAdmin
      .from('audit_log')
      .insert({
        event: 'DAILY_UPDATE',
        status: 'ERROR',
        detail: error instanceof Error ? error.message : 'Unknown error'
      });
    
    return NextResponse.json(
      { 
        error: 'Daily update failed',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}

// For manual triggers via POST
export async function POST(request: NextRequest) {
  // Same logic as GET but for manual triggers from the UI
  return GET(request);
}