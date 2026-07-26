#!/usr/bin/env bash
# Regression test for PB-10 Phase 1 blocker: exact constraint-definition
# validation.
#
# db/control/control-schema-upgrade.sql intentionally reuses the exact
# mr_metadata_ck CHECK-clause body from db/control/control-schema.sql,
# rather than resubmitting pg_get_constraintdef's deparsed output, because
# PostgreSQL deparses a reparsed AND-chain differently (more/less nested)
# depending on how it was originally parsed (BETWEEN vs. already-expanded
# >=/<=), even for the semantically identical constraint. Sharing literal
# source text is what makes a fresh install and an upgraded install produce
# byte-identical stored constraints — see the "no-op" branch comment in
# control-schema-upgrade.sql. This test fails CI the moment that literal
# text drifts between the two files (modulo indentation).
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

extract_body() {
  local file="$1"
  awk '/-- mr_metadata_ck-body: begin/{flag=1; next} /-- mr_metadata_ck-body: end/{flag=0} flag' "$file" \
    | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}

body_a="$(extract_body "$script_dir/control-schema.sql")"
body_b="$(extract_body "$script_dir/control-schema-upgrade.sql")"

if [[ -z "$body_a" || -z "$body_b" ]]; then
  echo "FAIL: could not locate the mr_metadata_ck-body markers in one or both files" >&2
  exit 1
fi

if [[ "$body_a" != "$body_b" ]]; then
  echo "FAIL: mr_metadata_ck CHECK-clause body differs between control-schema.sql and control-schema-upgrade.sql" >&2
  diff <(echo "$body_a") <(echo "$body_b") >&2 || true
  exit 1
fi

echo "PASS: mr_metadata_ck CHECK-clause body is identical (modulo indentation) in both files" >&2
