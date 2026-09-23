// Writes one row per stock per script run to bot_run_log, so the app's
// Live Lab can show a human-readable timeline of what the bot actually
// did — instead of needing to grep text log files over SSH.
export async function logRun(supabase, { runType, ticker, status, price = null, message = null }) {
  const { error } = await supabase.from("bot_run_log").insert({
    run_type: runType,
    ticker,
    status,
    price,
    message,
  });
  if (error) console.error("[runLog] Failed to write log row:", error.message);
}
