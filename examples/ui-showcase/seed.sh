#!/bin/sh
# Publishes the showcase artifacts without a model. Run where `sf` is on PATH:
#   ./seed.sh /absolute/path/to/examples/ui-showcase
# Docker: docker exec <container> /catalog/ui-showcase/seed.sh /catalog/ui-showcase
set -eu
ROOT="${1:?usage: seed.sh <absolute catalog root>}"
OWNER="stage:showcase:showcase"
pub() { # id kind title file [manifest]
  if [ -n "${5:-}" ]; then
    sf artifact publish --owner "$OWNER" --project-root "$ROOT" --id "$1" --kind "$2" --title "$3" --file "$ROOT/$4" --manifest "$ROOT/$5"
  else
    sf artifact publish --owner "$OWNER" --project-root "$ROOT" --id "$1" --kind "$2" --title "$3" --file "$ROOT/$4"
  fi
}
pub demo-notes static.markdown "Showcase notes" static/notes.md
pub demo-metrics static.table "Service metrics" static/metrics.csv
pub demo-text static.text "Plain text" static/report.txt
pub demo-card static.html "Static HTML card" static/card.html
pub demo-gallery live.declarative "Component gallery" programs/gallery.oui manifests/gallery.json
pub demo-sales live.declarative "Sales (filter + charts)" programs/sales.oui manifests/sales.json
pub demo-health live.declarative "Service health" programs/health.oui manifests/health.json
pub demo-html-sales live.html "Sales (Chart.js, bound)" html/sales-chartjs.html manifests/html-sales.json
pub demo-html-d3 live.html "D3 bars (static)" html/d3-bars.html manifests/html-d3.json
pub demo-html-health live.html "Health (ECharts, bound)" html/health-echarts.html manifests/html-health.json
echo "published 10 artifacts under $OWNER"
