#!/usr/bin/env bash
# Runs the tests: ./run.sh [database|bots|page|all]   (default: all)
# Each test's full output goes to out/logs/<name>.log and is printed if it fails.
# Needs `npm ci` here and in ../settler; the page tests also need Python with Playwright
# (see README.md). Set PYTHON to pick the Python (default python3).
set -uo pipefail
cd "$(dirname "$0")"
mkdir -p out/logs
PY=${PYTHON:-python3}
failed=()

run() {   # run <name> <command...>
  local name=$1 start=$SECONDS log=out/logs/$1.log
  shift
  if "$@" >"$log" 2>&1; then
    printf '  ok      %-18s %3d checks  %4ss\n' "$name" "$(grep -c '^PASS' "$log")" "$((SECONDS - start))"
  else
    printf '  FAILED  %-18s %3d failed  %4ss\n' "$name" "$(grep -c '^FAIL' "$log")" "$((SECONDS - start))"
    sed 's/^/          | /' "$log"
    failed+=("$name")
  fi
}

database() {
  echo "Database rules"
  run database node database/policies.test.mjs
}
bots() {
  echo "Bots"
  run archive node bots/archive.test.mjs
  run settle node bots/settle.test.mjs
  run settle-old-v2 env OLD=2 node bots/settle.test.mjs
  run cards node bots/cards.test.mjs
  run announce node bots/announce.test.mjs
  run stats node bots/stats.test.mjs
  run inspect node bots/inspect.test.mjs
}
page() {
  echo "Page"
  run game "$PY" page/game_test.py
  run season "$PY" page/season_test.py
  run phone "$PY" page/phone_test.py
  run cards-page "$PY" page/cards_test.py
  run account "$PY" page/account_test.py
  run widths "$PY" page/widths_test.py
}

case "${1:-all}" in
  database) database ;;
  bots) bots ;;
  page) page ;;
  all) database; bots; page ;;
  *) echo "usage: $0 [database|bots|page|all]" >&2; exit 2 ;;
esac

if ((${#failed[@]})); then
  echo "Failed: ${failed[*]}"
  exit 1
fi
echo "All passed."
