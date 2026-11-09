#!/usr/bin/env bash
# Runs one Cypress spec against the UAT stack while holding a machine-wide lock, so
# several people or agents writing specs at the same time never run more than one
# browser at once (each takes 1-2 GB).
#
#   scripts/cypress-slot.sh cypress/e2e/uat-claims.cy.js [extra cypress run args]
#
# The module configuration is not re-pinned per spec (several writers would rewrite it
# under each other): pin it once with `node scripts/module-config.mjs pin`.
# Screenshots of earlier runs are kept (trashAssetsBeforeRuns=false).
set -euo pipefail

UAT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
spec="${1:?usage: cypress-slot.sh <spec> [cypress args]}"
shift
lock="${UAT_CYPRESS_LOCK:-$UAT_DIR/.cypress-slot.lock}"

cd "$UAT_DIR"
exec flock "$lock" npx cypress run \
  --spec "$spec" \
  --config "baseUrl=${CYPRESS_BASE_URL:-http://localhost:3001},trashAssetsBeforeRuns=false,video=false" \
  --env PIN_MODULE_CONFIG=false \
  "$@"
