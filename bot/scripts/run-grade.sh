#!/bin/bash
# Nightly signal grading. Scores every ungraded daily_signals row whose next trading day's
# official data has arrived (see grade-signals.mjs). Measuring only: it never places orders.
# Scheduled for 20:30 EAT on weekdays, after the Vercel evening cron (20:00 UTC+3 window)
# has written the day's official rows.
set -uo pipefail

BOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$BOT_DIR/logs"
LOG_FILE="$LOG_DIR/grade-$(date +%Y-%m-%d).log"

mkdir -p "$LOG_DIR"
cd "$BOT_DIR"
find "$LOG_DIR" -name "grade-*.log" -mtime +30 -delete 2>/dev/null || true

echo "===== $(date -Iseconds) -- grading signals =====" >> "$LOG_FILE"
timeout --kill-after=30s 240s node grade-signals.mjs --apply >> "$LOG_FILE" 2>&1
EXIT_CODE=$?
echo "===== $(date -Iseconds) -- finished (exit $EXIT_CODE) =====" >> "$LOG_FILE"
exit $EXIT_CODE
