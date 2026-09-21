#!/usr/bin/env bash
# Start the portfolio and both lab backends locally.
#
# Differences from scripts/local_stack.py, which is the documented path:
#   - local_stack.py rebuilds the AsterKV binaries with `go build` and fails if
#     Go is not installed. This script reuses the binaries already in data/ and
#     only mentions Go if they are missing.
#   - local_stack.py supervises every service in one process, so when any single
#     child exits it terminates all the others. Here each service is independent.
#
# Usage:  ./scripts/run-local.sh          start everything still down
#         ./scripts/run-local.sh stop     stop everything this script starts
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
mkdir -p logs data/asterkv

listening() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

if [ "${1:-start}" = stop ]; then
  pkill -f "$ROOT/data/asterkv-node"    2>/dev/null && echo "stopped asterkv nodes"
  pkill -f "$ROOT/data/asterkv-gateway" 2>/dev/null && echo "stopped asterkv gateway"
  pkill -f "insiderpulse.lab_api"       2>/dev/null && echo "stopped insiderpulse"
  echo "The Vite dev server is left alone; stop it with Ctrl-C in its own terminal."
  exit 0
fi

# --- AsterKV: three Raft nodes on 5101-5103, HTTP gateway on 8010 ------------
if [ ! -x data/asterkv-node ] || [ ! -x data/asterkv-gateway ]; then
  echo "AsterKV binaries are missing from data/."
  echo "Install Go, then: python3 scripts/local_stack.py asterkv"
else
  for i in 1 2 3; do
    if listening "510$i"; then
      echo "node$i already up on 510$i"
    else
      peers=$(for j in 1 2 3; do [ "$j" -ne "$i" ] && printf "node%s=127.0.0.1:510%s," "$j" "$j"; done | sed 's/,$//')
      nohup ./data/asterkv-node --id="node$i" --addr="127.0.0.1:510$i" \
        --peers="$peers" --data="data/asterkv/node$i" > "logs/asterkv-node$i.log" 2>&1 &
      echo "started node$i on 510$i"
    fi
  done
  sleep 2
  if listening 8010; then
    echo "gateway already up on 8010"
  else
    nohup ./data/asterkv-gateway > logs/asterkv-gateway.log 2>&1 &
    echo "started gateway on 8010"
  fi
fi

# --- InsiderPulse: HTTP adapter on 8011 -------------------------------------
if listening 8011; then
  echo "insiderpulse already up on 8011"
elif [ ! -x .venv/bin/python ]; then
  echo "No .venv. Create it once with:"
  echo "  python3 -m venv .venv && .venv/bin/pip install -r vendor/insiderpulse/requirements.txt"
else
  ( cd vendor/insiderpulse && INSIDERPULSE_LAB_DATA="$ROOT/data/insiderpulse" \
      nohup "$ROOT/.venv/bin/python" -m insiderpulse.lab_api > "$ROOT/logs/insiderpulse.log" 2>&1 & )
  echo "started insiderpulse on 8011"
fi

sleep 3
echo
echo "Backends:"
for p in 5101 5102 5103 8010 8011; do
  listening "$p" && echo "  $p up" || echo "  $p DOWN (see logs/)"
done
echo
echo "Now run the frontend in this terminal:"
echo "  npm run dev      ->  http://127.0.0.1:5173"
