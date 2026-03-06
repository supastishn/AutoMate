#!/data/data/com.termux/files/usr/bin/bash
# AutoMate Termux Scheduler Trigger
# Called by termux-job-scheduler to wake up the gateway during Android sleep.
# Hitting /api/health is enough — the 15s cron tick loop catches up on all
# overdue jobs (heartbeat, cron, etc.) automatically once the process wakes.

CONFIG="${HOME}/.automate/automate.json"
PORT=18789

# Try to read port from config
if [ -f "$CONFIG" ]; then
  P=$(grep -o '"port"[[:space:]]*:[[:space:]]*[0-9]*' "$CONFIG" | head -1 | grep -o '[0-9]*$')
  [ -n "$P" ] && PORT=$P
fi

BASE="http://127.0.0.1:${PORT}"
NOTIFY=$(command -v termux-notification 2>/dev/null)

notify() {
  [ -n "$NOTIFY" ] && termux-notification --id automate-heartbeat --title "AutoMate" --content "$1" --priority low 2>/dev/null
}

# Wake the gateway — the cron tick loop will fire all overdue jobs
HEALTH=$(curl -sf -m 5 "${BASE}/api/health" 2>/dev/null)
if [ -z "$HEALTH" ]; then
  notify "Gateway not running — skipping"
  exit 0
fi

# Wait a few seconds for the tick loop to catch up, then check heartbeat log
sleep 20

# Check if heartbeat ran recently (within last 5 minutes)
LOG=$(curl -sf -m 5 "${BASE}/api/heartbeat/log?limit=1" 2>/dev/null)
STATUS=$(echo "$LOG" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)
if [ "$STATUS" = "sent" ]; then
  notify "Heartbeat completed ✓"
fi
