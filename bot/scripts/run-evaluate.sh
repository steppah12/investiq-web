#!/bin/bash
# Weekly fee-aware model evaluation. Retrains the real engine out of sample per stock, compares
# the BUY signal with buying any day and with Soko Play's commission, and stores a verdict per
# stock in model_verdicts (see evaluate-models.mjs). Measuring only: it never places orders.
# Scheduled for Sunday 06:00 EAT, when the market is closed and the machine is otherwise idle.
set -uo pipefail

BOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$BOT_DIR/logs"
LOG_FILE="$LOG_DIR/evaluate-$(date +%Y-%m-%d).log"

mkdir -p "$LOG_DIR"
cd "$BOT_DIR"
find "$LOG_DIR" -name "evaluate-*.log" -mtime +60 -delete 2>/dev/null || true

# Never run two evaluations at once (it is CPU heavy).
exec 9>/tmp/investiq-evaluate.lock
if ! flock -n 9; then
  echo "===== $(date -Iseconds) -- another evaluation holds the lock, skipping =====" >> "$LOG_FILE"
  exit 0
fi

echo "===== $(date -Iseconds) -- evaluating models =====" >> "$LOG_FILE"
timeout --kill-after=60s 1500s node evaluate-models.mjs --save >> "$LOG_FILE" 2>&1
EXIT_CODE=$?
echo "===== $(date -Iseconds) -- finished (exit $EXIT_CODE) =====" >> "$LOG_FILE"
exit $EXIT_CODE
