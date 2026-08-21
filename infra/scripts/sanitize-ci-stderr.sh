#!/usr/bin/env bash

set -u

fixed='[PB10_CI_DIAGNOSTIC] Database step output was sanitized; use the step name and exit status to identify the failing boundary.'

filter_stream() {
  local mode=$1 input status=0
  input=$(mktemp) || return 70
  if [[ "${PB10_CI_SANITIZER_FAIL:-}" == read ]]; then
    rm -f "$input"
    return 70
  fi
  if ! cat >"$input"; then
    rm -f "$input"
    return 70
  fi
  if [[ "${PB10_CI_SANITIZER_FAIL:-}" == "$mode" ]]; then
    rm -f "$input"
    return 70
  fi
  if [[ -s "$input" ]]; then
    if [[ "$mode" == stdout ]]; then
      awk -v fixed="$fixed" '
        /^(TAP version 13|# Subtest: |(ok|not ok) [0-9]+ - |1\.[0-9]+|# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) [0-9.]+)$/ { print; next }
        { suppressed = 1 }
        END { if (suppressed) print fixed }
      ' "$input" || status=70
    else
      printf '%s\n' "$fixed" >&2 || status=70
    fi
  fi
  [[ "${PB10_CI_SANITIZER_FAIL:-}" == write ]] && status=70
  rm -f "$input" || status=70
  return "$status"
}

run_command() {
  local command_file=$1 directory child_status stdout_status stderr_status output_status cleanup_status
  if [[ "${PB10_CI_SANITIZER_FAIL:-}" == setup ]]; then
    printf '%s\n' '[PB10_CI_SANITIZER_FAILED] CI diagnostic sanitization failed closed.' >&2
    return 70
  fi
  directory=$(mktemp -d) || return 70

  bash --noprofile --norc -eo pipefail "$command_file" >"$directory/stdout.raw" 2>"$directory/stderr.raw"
  child_status=$?
  bash "$0" --filter stdout <"$directory/stdout.raw" >"$directory/stdout.clean"
  stdout_status=$?
  bash "$0" --filter stderr <"$directory/stderr.raw" 2>"$directory/stderr.clean"
  stderr_status=$?
  cat "$directory/stdout.clean"
  output_status=$?
  cat "$directory/stderr.clean" >&2 || output_status=70
  rm -rf "$directory"
  cleanup_status=$?
  [[ "${PB10_CI_SANITIZER_FAIL:-}" == finalize ]] && cleanup_status=70

  if (( stdout_status != 0 || stderr_status != 0 || output_status != 0 || cleanup_status != 0 )); then
    printf '%s\n' '[PB10_CI_SANITIZER_FAILED] CI diagnostic sanitization failed closed.' >&2
    (( child_status != 0 )) && return "$child_status"
    return 70
  fi
  return "$child_status"
}

self_test() {
  local directory status
  directory=$(mktemp -d) || return 1
  printf '%s\n' 'printf "TAP version 13\n# pass 1\nPHASE2E_STDOUT_CANARY\n"' 'printf "PHASE2E_STDERR_CANARY\n" >&2' >"$directory/success.sh"
  printf '%s\n' 'exit 23' >"$directory/failure.sh"

  bash "$0" "$directory/success.sh" >"$directory/result" 2>&1
  status=$?
  [[ $status == 0 ]] || { rm -rf "$directory"; return 1; }
  grep -q '^TAP version 13$' "$directory/result" || { rm -rf "$directory"; return 1; }
  ! grep -q 'PHASE2E_.*_CANARY' "$directory/result" || { rm -rf "$directory"; return 1; }

  bash "$0" "$directory/failure.sh" >/dev/null 2>&1
  status=$?
  [[ $status == 23 ]] || { rm -rf "$directory"; return 1; }

  for failure in setup read write stdout finalize; do
    PB10_CI_SANITIZER_FAIL="$failure" bash "$0" "$directory/success.sh" >/dev/null 2>&1
    status=$?
    [[ $status == 70 ]] || { rm -rf "$directory"; return 1; }
  done

  PB10_CI_SANITIZER_FAIL=stderr bash "$0" "$directory/failure.sh" >/dev/null 2>&1
  status=$?
  [[ $status == 23 ]] || { rm -rf "$directory"; return 1; }

  rm -rf "$directory"
  printf '%s\n' 'PB-10 CI sanitizer self-check passed'
}

case "${1:-}" in
  --filter) filter_stream "${2:?stream mode is required}" ;;
  --self-test) self_test ;;
  "") printf '%s\n' 'usage: sanitize-ci-stderr.sh <command-file>' >&2; exit 64 ;;
  *) run_command "$1" ;;
esac
