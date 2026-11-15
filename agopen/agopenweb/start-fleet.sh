#!/bin/bash
# Start N extra AgOpenWeb copies, one per simulated tractor, on ports 5175, 5176, ...
#   ./start-fleet.sh 3        start 3 tractors
#   ./start-fleet.sh stop     stop them all
# Needs the patched build in ./bin (see README.md).
M="$(cd "$(dirname "$0")" && pwd)"
# .NET installed with the dotnet-install script lives in ~/.dotnet; a system-wide install needs nothing set.
if [ -z "$DOTNET_ROOT" ] && [ -d "$HOME/.dotnet" ]; then export DOTNET_ROOT="$HOME/.dotnet"; fi
if [ "$1" = "stop" ]; then
  pkill -f "AgOpenWeb.Desktop --headless"
  for k in $(seq 1 40); do pgrep -f "AgOpenWeb.Desktop --headless" >/dev/null || break; sleep 0.5; done
  echo "stopped"; exit 0
fi
N=${1:-2}
for i in $(seq 1 "$N"); do
  P=$((5174 + i))
  if curl -s -o /dev/null "http://localhost:$P/"; then echo "tractor $i already up on $P"; continue; fi
  mkdir -p "$M/data-$P"
  (cd "$M/bin" && AGOPENWEB_PORT=$P AGOPENWEB_OPERATOR=Fleet AGOPENWEB_DATA="$M/data-$P" nohup ./AgOpenWeb.Desktop --headless > "$M/tractor-$P.log" 2>&1 &)
  echo "tractor $i starting on http://localhost:$P"
done
