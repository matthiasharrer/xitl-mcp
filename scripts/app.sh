#!/usr/bin/env bash
# Background process manager for xitl inside the Coder workspace.
#
# Usage:
#   scripts/app.sh start | stop | restart | status | logs [api|web]
#
# Ports:  API -> http://localhost:3002   Web -> http://localhost:5175 (WEB_PORT=5173 to take
#         rezepte's port while rezepte is stopped)
# PIDs and logs live under THIS repo's .run/ (gitignored), and stop only ever
# signals the PIDs recorded there — it cannot touch the sibling apps
# (rezepte 3000/5173, haushalts-todos 3001/5174, each with its own .run/).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$ROOT/.run"
mkdir -p "$RUN_DIR"

API_PID="$RUN_DIR/api.pid"
WEB_PID="$RUN_DIR/web.pid"
API_LOG="$RUN_DIR/api.log"
WEB_LOG="$RUN_DIR/web.log"

is_running() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }

start_one() {
  local name="$1" pidfile="$2" logfile="$3"; shift 3
  if is_running "$pidfile"; then
    echo "  $name already running (pid $(cat "$pidfile"))"
    return
  fi
  cd "$ROOT"
  # setsid puts the process in its own group so we can kill it + all children.
  setsid "$@" >"$logfile" 2>&1 </dev/null &
  echo $! >"$pidfile"
  echo "  $name started (pid $(cat "$pidfile")) -> ${logfile#$ROOT/}"
}

stop_one() {
  local name="$1" pidfile="$2"
  if is_running "$pidfile"; then
    local pid; pid="$(cat "$pidfile")"
    kill -- -"$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
    rm -f "$pidfile"
    echo "  $name stopped"
  else
    echo "  $name not running"
    rm -f "$pidfile"
  fi
}

status_one() {
  local name="$1" pidfile="$2"
  if is_running "$pidfile"; then
    echo "  $name: running (pid $(cat "$pidfile"))"
  else
    echo "  $name: stopped"
  fi
}

case "${1:-}" in
  start)
    echo "Starting xitl..."
    start_one api "$API_PID" "$API_LOG" env PORT=3002 npm --workspace @xitl/api run dev
    start_one web "$WEB_PID" "$WEB_LOG" env WEB_PORT="${WEB_PORT:-5175}" npm --workspace @xitl/web run dev
    echo "Open the web app on the Coder-forwarded port ${WEB_PORT:-5175}."
    ;;
  stop)
    echo "Stopping xitl..."
    stop_one api "$API_PID"
    stop_one web "$WEB_PID"
    ;;
  restart)
    "$0" stop
    sleep 1
    "$0" start
    ;;
  status)
    status_one api "$API_PID"
    status_one web "$WEB_PID"
    ;;
  logs)
    which="${2:-both}"
    if [ "$which" = api ] || [ "$which" = both ]; then
      echo "===== api ($API_LOG) ====="; tail -n 60 "$API_LOG" 2>/dev/null || echo "  (no log yet)"
    fi
    if [ "$which" = web ] || [ "$which" = both ]; then
      echo "===== web ($WEB_LOG) ====="; tail -n 60 "$WEB_LOG" 2>/dev/null || echo "  (no log yet)"
    fi
    ;;
  *)
    echo "Usage: scripts/app.sh {start|stop|restart|status|logs [api|web]}"
    exit 1
    ;;
esac
