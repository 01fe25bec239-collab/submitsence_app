#!/usr/bin/env bash
# Regression test for PB-10 Phase 1 blocker: frozen previous-schema fixture
# integrity.
#
# db/control/fixtures/control-schema.pre-metadata-filename-ordinal.sql must
# be byte-identical to the control schema at the pinned commit
# 5324116250977b5e8ac24bc83b6cae89ebcbd990, with exactly one allowed
# difference: the explanatory header this fixture adds on top (everything
# before the "-- PB-10 Step 2 migration control schema." marker line, which
# is the pinned file's own first line). Any other drift — the header
# claiming to be frozen while the body silently changed — fails closed.
set -euo pipefail

PINNED_COMMIT="5324116250977b5e8ac24bc83b6cae89ebcbd990"
MARKER="-- PB-10 Step 2 migration control schema."

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fixture="$script_dir/fixtures/control-schema.pre-metadata-filename-ordinal.sql"
repo_root="$(cd "$script_dir/../.." && pwd)"

pinned="$(cd "$repo_root" && git show "${PINNED_COMMIT}:db/control/control-schema.sql")"

if ! grep -qxF -e "$MARKER" "$fixture"; then
  echo "FAIL: fixture header marker line missing or altered: expected an exact line '$MARKER'" >&2
  exit 1
fi

fixture_body="$(sed -n "/^$(printf '%s' "$MARKER" | sed 's/[.[\*^$/]/\\&/g')\$/,\$p" "$fixture")"

if [[ "$fixture_body" != "$pinned" ]]; then
  echo "FAIL: db/control/fixtures/control-schema.pre-metadata-filename-ordinal.sql has drifted from the pinned commit ${PINNED_COMMIT}:db/control/control-schema.sql (beyond the documented header)" >&2
  diff <(echo "$pinned") <(echo "$fixture_body") >&2 || true
  exit 1
fi

echo "PASS: fixture matches ${PINNED_COMMIT}:db/control/control-schema.sql exactly (documented header aside)" >&2
