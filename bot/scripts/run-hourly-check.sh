#!/bin/bash
set -uo pipefail

BOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$BOT_DIR/logs"
LOG_FILE="$LOG_DIR/hourly-$(date +%Y-%m-%d).log"

mkdir -p "$LOG_DIR"
cd "$BOT_DIR"
find "$LOG_DIR" -name "hourly-*.log" -mtime +30 -delete 2>/dev/null || true

echo "===== $(date -Iseconds) — hourly price check =====" >> "$LOG_FILE"
node hourly-price-check.mjs >> "$LOG_FILE" 2>&1
EXIT_CODE=$?
echo "===== $(date -Iseconds) — finished (exit $EXIT_CODE) =====" >> "$LOG_FILE"
exit $EXIT_CODE
