#!/bin/bash
# Wrapper for `npm run trade`, meant to be called from cron.
#
# Why this exists rather than pointing cron straight at `npm run trade`:
# cron runs with a minimal environment (no PATH to node/npm the way your
# interactive shell has), and it's useful to have timestamped, rotating
# logs you can actually check in the morning instead of cron's default
# "silently emails root" behavior (which usually isn't set up to go
# anywhere on a personal machine).

set -uo pipefail

BOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$BOT_DIR/logs"
LOG_FILE="$LOG_DIR/trade-$(date +%Y-%m-%d).log"

mkdir -p "$LOG_DIR"
cd "$BOT_DIR"

# Keep logs from piling up forever — 30 days is plenty to debug anything
# recent while not eating disk space indefinitely.
find "$LOG_DIR" -name "trade-*.log" -mtime +30 -delete 2>/dev/null || true

echo "===== $(date -Iseconds) — starting trade run =====" >> "$LOG_FILE"
npm run trade >> "$LOG_FILE" 2>&1
EXIT_CODE=$?
echo "===== $(date -Iseconds) — trade run finished (exit $EXIT_CODE) =====" >> "$LOG_FILE"
exit $EXIT_CODE
