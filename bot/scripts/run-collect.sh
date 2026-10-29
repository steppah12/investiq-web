#!/bin/bash
# Market data collector (collect-market.mjs): one direct API call captures the whole Soko Play board.
# Runs every five minutes during the session (cron times are in the install notes). Extra arguments
# such as --final are passed straight through. Measuring only: it places no orders.
# Silent skips: market holidays (bot/holidays.txt) and an overlapping run (flock).
set -uo pipefail

BOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$BOT_DIR/logs"
LOG_FILE="$LOG_DIR/collect-$(date +%Y-%m-%d).log"

mkdir -p "$LOG_DIR"
cd "$BOT_DIR"
find "$LOG_DIR" -name "collect-*.log" -mtime +30 -delete 2>/dev/null || true

# Market holiday: nothing to collect (Soko Play still says "Regular Trading Session" on holidays).
if tr -d '\r' 2>/dev/null < "$BOT_DIR/holidays.txt" | grep -qxF "$(date +%Y-%m-%d)"; then
  exit 0
fi

# Never run two captures at once.
exec 9>/tmp/investiq-collect.lock
flock -n 9 || exit 0

echo "===== $(date -Iseconds) -- collect $* =====" >> "$LOG_FILE"
timeout --kill-after=20s 150s node collect-market.mjs "$@" >> "$LOG_FILE" 2>&1
EXIT_CODE=$?
[ "$EXIT_CODE" -ne 0 ] && echo "===== $(date -Iseconds) -- collect failed (exit $EXIT_CODE) =====" >> "$LOG_FILE"
exit $EXIT_CODE
