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
grep -q '"monitoring"' terraform/modules/network/main.tf
grep -q 'private_dns_enabled[[:space:]]*=[[:space:]]*true' terraform/modules/network/main.tf
grep -q '{ name = "ENVIRONMENT", value = var.environment }' terraform/compute.tf
grep -q 'environment = concat(local.common_environment' terraform/compute.tf

queue_alarm="$(sed -n '/resource "aws_cloudwatch_metric_alarm" "queue_depth_high"/,/^}/p' terraform/observability.tf)"
freshness_alarm="$(sed -n '/resource "aws_cloudwatch_metric_alarm" "queue_metrics_missing"/,/^}/p' terraform/observability.tf)"
grep -q 'treat_missing_data[[:space:]]*=[[:space:]]*"notBreaching"' <<<"$queue_alarm"
grep -q 'count[[:space:]]*=[[:space:]]*var.worker_desired_count > 0 ? 1 : 0' <<<"$freshness_alarm"
grep -q 'metric_name[[:space:]]*=[[:space:]]*"QueueDepth"' <<<"$freshness_alarm"
grep -q 'unit[[:space:]]*=[[:space:]]*"Count"' <<<"$freshness_alarm"
grep -q 'statistic[[:space:]]*=[[:space:]]*"Maximum"' <<<"$freshness_alarm"
grep -q 'period[[:space:]]*=[[:space:]]*60' <<<"$freshness_alarm"
grep -q 'evaluation_periods[[:space:]]*=[[:space:]]*30' <<<"$freshness_alarm"
grep -q 'datapoints_to_alarm[[:space:]]*=[[:space:]]*30' <<<"$freshness_alarm"
grep -q 'comparison_operator[[:space:]]*=[[:space:]]*"LessThanThreshold"' <<<"$freshness_alarm"
grep -q 'threshold[[:space:]]*=[[:space:]]*0' <<<"$freshness_alarm"
grep -q 'treat_missing_data[[:space:]]*=[[:space:]]*"breaching"' <<<"$freshness_alarm"

! grep -RInE 'OldestJobAgeHigh|oldest_job_age.*threshold|oldest.*age.*variable' terraform
! grep -RInE 'resource "aws_appautoscaling_(target|policy)" "worker|QueueDepth.*target_tracking' terraform
! grep -InE 'TenantId|ProjectId|JobId|DocumentId|WorkerPool|TaskId|LeaseToken' backend/src/worker/queue-metrics.ts

if grep -RInEi '(redis|bullmq|elasticache|6379)' terraform .github --include='*.tf' --include='*.example' --include='*.hcl' --include='*.yml' --include='*.yaml'; then
  echo "Redis/ElastiCache infrastructure requires an explicit architecture change." >&2
  exit 1
fi

if grep -RInE '(AKIA[0-9A-Z]{16}|sk_(live|test)_[A-Za-z0-9]+|whsec_[A-Za-z0-9]+)' terraform infra .github; then
  echo "Possible committed secret found." >&2
  exit 1
fi

echo "Static PostgreSQL queue metrics, alarms, endpoints, private-data, secret, and Australian-region assertions passed."
