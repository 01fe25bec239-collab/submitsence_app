#!/usr/bin/env bash
set -euo pipefail

regions="$(grep -RhoE '(af|ap|ca|eu|il|me|mx|sa|us)-(central|east|north|northeast|south|southeast|southwest|west)-[0-9]' terraform --include='*.tf' --include='*.example' | sort -u || true)"
bad_regions="$(printf '%s\n' "$regions" | grep -Ev '^(ap-southeast-2|ap-southeast-4)?$' || true)"
[[ -z "$bad_regions" ]] || { echo "Non-Australian region found: $bad_regions" >&2; exit 1; }

grep -q 'publicly_accessible[[:space:]]*=[[:space:]]*false' terraform/data.tf
grep -q 'storage_encrypted[[:space:]]*=[[:space:]]*true' terraform/data.tf
grep -q 'allow_insecure_http[[:space:]]*=[[:space:]]*false' terraform/environments/production.tfvars.example
grep -q 'processing_jobs' backend/src/worker/worker.ts
grep -q 'claim_next_job' backend/src/worker/worker.ts

if grep -RInEi '(redis|bullmq|elasticache|6379)' terraform .github --include='*.tf' --include='*.example' --include='*.hcl' --include='*.yml' --include='*.yaml'; then
  echo "Redis/ElastiCache infrastructure requires an explicit architecture change." >&2
  exit 1
fi

if grep -RInE '(AKIA[0-9A-Z]{16}|sk_(live|test)_[A-Za-z0-9]+|whsec_[A-Za-z0-9]+)' terraform infra .github; then
  echo "Possible committed secret found." >&2
  exit 1
fi

echo "Static PostgreSQL queue, encryption, private-data, secret, and Australian-region assertions passed."
