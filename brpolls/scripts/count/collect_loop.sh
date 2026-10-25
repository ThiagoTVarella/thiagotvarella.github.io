#!/bin/bash
# Coleta um retrato a cada 2 minutos e guarda no branch de trabalho (não publica o site).
cd "$(dirname "$0")/../../.." || exit 1
CACHE=${1:-/tmp/live_cache.json}; BR=$(git rev-parse --abbrev-ref HEAD)
while true; do
  s=$(date +%s)
  if node brpolls/scripts/count/live.js "$CACHE"; then
    git add brpolls/data/count/live_history.json brpolls/data/count/live_latest.json
    git commit -q -m "Apuração: retrato das $(TZ=America/Sao_Paulo date +%H:%M)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0154DwzwL6rXv3iWQR4gBZEd" && git push -q origin "HEAD:$BR"
    grep -q '"pct":100' brpolls/data/count/live_latest.json && exit 0
  fi
  e=$(( $(date +%s) - s )); [ $e -lt 120 ] && sleep $((120 - e))
done
