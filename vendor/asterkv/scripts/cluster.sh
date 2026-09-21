#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
pids=""
cleanup() {
  trap - INT TERM EXIT
  for pid in $pids; do kill -TERM "$pid" 2>/dev/null || true; done
  for pid in $pids; do wait "$pid" 2>/dev/null || true; done
}
trap cleanup INT TERM EXIT
mkdir -p data
for i in 1 2 3; do
  peers=""
  for j in 1 2 3; do
    if [ "$i" != "$j" ]; then
      [ -z "$peers" ] || peers="$peers,"
      peers="${peers}node$j=127.0.0.1:500$j"
    fi
  done
  ./bin/asterkv-node --id="node$i" --addr="127.0.0.1:500$i" --peers="$peers" --data="data/node$i" &
  pids="$pids $!"
done
wait
