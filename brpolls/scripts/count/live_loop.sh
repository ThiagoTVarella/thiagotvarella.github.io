#!/bin/bash
# A cada 5 minutos: lê o TSE, projeta, e publica o histórico (só os arquivos live_*.json). Para quando chegar a 100%.
cd "$(dirname "$0")/../../.." || exit 1
CACHE=${1:-/tmp/live_cache.json}
BR=$(git rev-parse --abbrev-ref HEAD)
while true; do
  s=$(date +%s)
  if node brpolls/scripts/count/live.js "$CACHE"; then
    git add brpolls/data/count/live_history.json brpolls/data/count/live_latest.json
    git commit -q -m "Apuração: retrato das $(TZ=America/Sao_Paulo date +%H:%M)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0154DwzwL6rXv3iWQR4gBZEd" && \
    for i in 1 2 3; do git push -q origin HEAD:master "HEAD:$BR" && break; sleep $((2*i)); done
    grep -q '"pct":100' brpolls/data/count/live_latest.json && { echo "apuração terminou"; exit 0; }
  fi
  e=$(( $(date +%s) - s )); [ $e -lt 300 ] && sleep $((300 - e))
done
