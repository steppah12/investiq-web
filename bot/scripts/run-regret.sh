#!/bin/bash
# Wrapper for `npm run regret`, meant to be called from cron.
# Same reasoning as run-trade.sh — see that file's comment.

set -uo pipefail

BOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$BOT_DIR/logs"
LOG_FILE="$LOG_DIR/regret-$(date +%Y-%m-%d).log"

mkdir -p "$LOG_DIR"
cd "$BOT_DIR"

find "$LOG_DIR" -name "regret-*.log" -mtime +30 -delete 2>/dev/null || true

echo "===== $(date -Iseconds) — starting regret run =====" >> "$LOG_FILE"
npm run regret >> "$LOG_FILE" 2>&1
EXIT_CODE=$?
echo "===== $(date -Iseconds) — regret run finished (exit $EXIT_CODE) =====" >> "$LOG_FILE"
exit $EXIT_CODE
