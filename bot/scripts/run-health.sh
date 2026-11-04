#!/bin/bash
# Watchdog (health-check.mjs): checks the session file, disk space and that each scheduled job
# produced fresh data, saves the verdict to bot_health, and sends a phone alert if
# ALERT_WEBHOOK_URL is set in .env. It does not log in to Soko Play and places no orders.
# Exit code 1 means a FAIL verdict (the log says why). Extra arguments such as --dry-run pass through.
set -uo pipefail

BOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$BOT_DIR/logs"
LOG_FILE="$LOG_DIR/health-$(date +%Y-%m-%d).log"

mkdir -p "$LOG_DIR"
cd "$BOT_DIR"
find "$LOG_DIR" -name "health-*.log" -mtime +60 -delete 2>/dev/null || true

exec 9>/tmp/investiq-health.lock
flock -n 9 || exit 0

echo "===== $(date -Iseconds) -- health check $* =====" >> "$LOG_FILE"
timeout --kill-after=10s 90s node health-check.mjs "$@" >> "$LOG_FILE" 2>&1
EXIT_CODE=$?
echo "===== $(date -Iseconds) -- finished (exit $EXIT_CODE) =====" >> "$LOG_FILE"
exit $EXIT_CODE
