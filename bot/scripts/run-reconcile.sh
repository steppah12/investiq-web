#!/bin/bash
set -uo pipefail

BOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$BOT_DIR/logs"
LOG_FILE="$LOG_DIR/reconcile-$(date +%Y-%m-%d).log"

mkdir -p "$LOG_DIR"
cd "$BOT_DIR"
find "$LOG_DIR" -name "reconcile-*.log" -mtime +30 -delete 2>/dev/null || true

echo "===== $(date -Iseconds) — morning close reconciliation =====" >> "$LOG_FILE"
node reconcile-yesterday-close.mjs >> "$LOG_FILE" 2>&1
EXIT_CODE=$?
echo "===== $(date -Iseconds) — finished (exit $EXIT_CODE) =====" >> "$LOG_FILE"
exit $EXIT_CODE
