#!/usr/bin/env bash
set -euo pipefail

: "${AWS_REGION:?AWS_REGION is required}"
: "${ENVIRONMENT:?ENVIRONMENT is required}"
[[ "$ENVIRONMENT" == "staging" ]] || { echo "Queue alert simulation is staging-only." >&2; exit 1; }

for metric in JobFailures OcrFailures PackageFailures IntegrationFailures AuthFailures; do
  aws cloudwatch put-metric-data \
    --region "$AWS_REGION" \
    --namespace SubmitSense/Jobs \
    --metric-data "MetricName=$metric,Dimensions=[{Name=Environment,Value=$ENVIRONMENT}],Value=1,Unit=Count"
done

suffix="${GITHUB_RUN_ID:-$$}"
alarm_name="submitsense-staging-pb07-queue-metrics-missing-${suffix}"
synthetic_environment="pb07-simulation-${suffix}"
created=0
cleanup() {
  if [[ "$created" == 1 ]]; then
    aws cloudwatch delete-alarms --region "$AWS_REGION" --alarm-names "$alarm_name"
  fi
}
trap cleanup EXIT

aws cloudwatch put-metric-alarm \
  --region "$AWS_REGION" \
  --alarm-name "$alarm_name" \
  --alarm-description "Temporary PB-07 staging freshness simulation" \
  --namespace SubmitSense/Jobs \
  --metric-name QueueDepth \
  --dimensions "Name=Environment,Value=$synthetic_environment" \
  --unit Count \
  --statistic Maximum \
  --period 60 \
  --evaluation-periods 30 \
  --datapoints-to-alarm 30 \
  --comparison-operator LessThanThreshold \
  --threshold 0 \
  --treat-missing-data breaching
created=1

wait_for_state() {
  local expected="$1"
  local state
  for _ in {1..24}; do
    state="$(aws cloudwatch describe-alarms --region "$AWS_REGION" --alarm-names "$alarm_name" --query 'MetricAlarms[0].StateValue' --output text)"
    [[ "$state" == "$expected" ]] && return
    sleep 10
  done
  echo "Temporary freshness alarm did not reach $expected (last state: $state)." >&2
  return 1
}

wait_for_state ALARM
aws cloudwatch put-metric-data \
  --region "$AWS_REGION" \
  --namespace SubmitSense/Jobs \
  --metric-data "MetricName=QueueDepth,Dimensions=[{Name=Environment,Value=$synthetic_environment}],Value=0,Unit=Count"
wait_for_state OK

echo "Failure metrics published and isolated QueueMetricsMissing missing/recovery behavior verified in staging."
