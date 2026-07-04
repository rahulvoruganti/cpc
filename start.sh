#!/bin/bash
# Starts CPC backend and frontend in the background, detached from this shell.
set -e
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$ROOT_DIR/logs"
mkdir -p "$LOG_DIR"

start_one() {
  local name="$1" dir="$2"
  if [ -f "$ROOT_DIR/$name.pid" ] && kill -0 "$(cat "$ROOT_DIR/$name.pid")" 2>/dev/null; then
    echo "$name already running (PID $(cat "$ROOT_DIR/$name.pid"))"
    return
  fi
  cd "$ROOT_DIR/$dir"
  nohup npm run dev > "$LOG_DIR/$name.log" 2>&1 &
  echo $! > "$ROOT_DIR/$name.pid"
  cd "$ROOT_DIR"
  echo "$name started (PID $(cat "$ROOT_DIR/$name.pid")) — logs: $LOG_DIR/$name.log"
}

# Make sure nothing is squatting on our ports (e.g. orphaned node --watch
# children from a previous run) before we try to bind.
free_port() {
  local port="$1" pids
  pids="$(netstat -ano 2>/dev/null | grep -E ":${port}[[:space:]]" | grep LISTENING | awk '{print $NF}' | sort -u)"
  for pid in $pids; do
    taskkill //F //PID "$pid" >/dev/null 2>&1 && echo "Freed port $port (orphan PID $pid)"
  done
}
free_port 4100
free_port 5273

start_one "backend" "backend"
start_one "frontend" "frontend"

echo ""
echo "CPC running detached. Backend :4100  Frontend :5273"
echo "Tail logs: tail -f logs/backend.log"
echo "Stop with: ./stop.sh"
