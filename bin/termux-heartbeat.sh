#!/data/data/com.termux/files/usr/bin/bash
# AutoMate Termux Heartbeat Trigger
# Called by termux-job-scheduler to wake up and run heartbeat during Android sleep.
# Usage: termux-job-scheduler --script ~/.automate/termux-heartbeat.sh --period-ms 3600000 --persisted true

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

# Check if gateway is running
HEALTH=$(curl -sf -m 5 "${BASE}/api/health" 2>/dev/null)
if [ -z "$HEALTH" ]; then
  notify "Gateway not running — skipping heartbeat"
  exit 0
fi

# Trigger heartbeat
RESULT=$(curl -sf -m 300 -X POST "${BASE}/api/heartbeat/trigger" 2>/dev/null)
if [ -z "$RESULT" ]; then
  notify "Heartbeat trigger failed (timeout or error)"
  exit 1
fi

STATUS=$(echo "$RESULT" | grep -o '"result":"[^"]*"' | cut -d'"' -f4)
if [ "$STATUS" = "sent" ]; then
  notify "Heartbeat completed ✓"
elif [ "$STATUS" = "skipped" ]; then
  # Nothing to do — don't spam notifications
  :
else
  ERR=$(echo "$RESULT" | grep -o '"error":"[^"]*"' | cut -d'"' -f4)
  notify "Heartbeat: ${ERR:-unknown status}"
fi
