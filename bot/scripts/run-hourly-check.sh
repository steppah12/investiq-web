#!/bin/bash
set -uo pipefail

BOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$BOT_DIR/logs"
LOG_FILE="$LOG_DIR/hourly-$(date +%Y-%m-%d).log"

mkdir -p "$LOG_DIR"
cd "$BOT_DIR"
find "$LOG_DIR" -name "hourly-*.log" -mtime +30 -delete 2>/dev/null || true

# Added 2026-10-20: skip market holidays (dates in bot/holidays.txt). Nothing trades on those
# days, so a run would only add noise rows and needless Soko Play logins.
if tr -d '\r' 2>/dev/null < "$BOT_DIR/holidays.txt" | grep -qxF "$(date +%Y-%m-%d)"; then
  echo "===== $(date -Iseconds) -- market holiday, skipping =====" >> "$LOG_FILE"
  exit 0
fi

echo "===== $(date -Iseconds) — hourly price check =====" >> "$LOG_FILE"
timeout --kill-after=30s 240s node hourly-price-check.mjs >> "$LOG_FILE" 2>&1
EXIT_CODE=$?
echo "===== $(date -Iseconds) — finished (exit $EXIT_CODE) =====" >> "$LOG_FILE"
exit $EXIT_CODE
