#!/usr/bin/env bash
# Refresh the full brpolls pipeline: TSE registry -> database -> ratings ->
# average -> forecast -> history -> backtest (-> JS parity test if present).
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

REGISTRY_URL="https://cdn.tse.jus.br/estatistica/sead/odsele/pesquisa_eleitoral/pesquisa_eleitoral_2026.zip"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "==> Downloading TSE registry"
curl -fsSL --retry 3 -o "$TMP/registry.zip" "$REGISTRY_URL"
unzip -q -o "$TMP/registry.zip" -d "$TMP"

echo "==> build_database"
python3 scripts/build_database.py --registry "$TMP/pesquisa_eleitoral_2026_BRASIL.csv"
echo "==> ratings"
python3 scripts/ratings.py
echo "==> average"
python3 scripts/average.py --ratings data/pollster_ratings.json
echo "==> forecast"
python3 scripts/forecast.py
echo "==> forecast_history"
python3 scripts/forecast_history.py
echo "==> backtest"
python3 scripts/backtest.py

if [[ -f scripts/test_parity.js ]]; then
  echo "==> test_parity"
  node scripts/test_parity.js
fi

python3 - <<'PY'
import json
d = json.load(open("data/average.json"))
c = d["current"]
print(f"Average as of {d['as_of']}: Lula {c['lula']}% / Flavio {c['flavio']}% "
      f"(95% CI {c['ci95'][0]}-{c['ci95'][1]}, n_eff {c.get('n_eff')})")
PY
