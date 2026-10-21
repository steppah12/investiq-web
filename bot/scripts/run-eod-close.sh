#!/bin/bash
set -uo pipefail

BOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$BOT_DIR/logs"
LOG_FILE="$LOG_DIR/eod-$(date +%Y-%m-%d).log"

mkdir -p "$LOG_DIR"
cd "$BOT_DIR"
find "$LOG_DIR" -name "eod-*.log" -mtime +30 -delete 2>/dev/null || true

# Added 2026-10-20: skip market holidays (dates in bot/holidays.txt). Nothing trades on those
# days, so a run would only add noise rows and needless Soko Play logins.
if tr -d '\r' 2>/dev/null < "$BOT_DIR/holidays.txt" | grep -qxF "$(date +%Y-%m-%d)"; then
  echo "===== $(date -Iseconds) -- market holiday, skipping =====" >> "$LOG_FILE"
  exit 0
fi

echo "===== $(date -Iseconds) — EOD close + intraday reconciliation =====" >> "$LOG_FILE"
# Retry up to 3 times (network/DNS outages, timeouts). Repeats are harmless: the archive is
# insert-only and the Vercel fetch answers NO_NEW_DATA when nothing is new.
for ATTEMPT in 1 2 3; do
  timeout --kill-after=30s 240s node eod-close-and-match.mjs >> "$LOG_FILE" 2>&1
  EXIT_CODE=$?
  [ "$EXIT_CODE" -eq 0 ] && break
  echo "===== $(date -Iseconds) -- attempt $ATTEMPT failed (exit $EXIT_CODE) =====" >> "$LOG_FILE"
  [ "$ATTEMPT" -lt 3 ] && sleep 240
done
echo "===== $(date -Iseconds) — finished (exit $EXIT_CODE) =====" >> "$LOG_FILE"
exit $EXIT_CODE
