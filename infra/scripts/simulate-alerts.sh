#!/usr/bin/env bash
set -euo pipefail

: "${AWS_REGION:?AWS_REGION is required}"
: "${ENVIRONMENT:?ENVIRONMENT is required}"

for metric in JobFailures OcrFailures PackageFailures IntegrationFailures AuthFailures; do
  aws cloudwatch put-metric-data \
    --region "$AWS_REGION" \
    --namespace SubmitSense/Jobs \
    --metric-data "MetricName=$metric,Dimensions=[{Name=Environment,Value=$ENVIRONMENT}],Value=1,Unit=Count"
done

echo "Failure metrics published. Confirm the ${ENVIRONMENT} alarm topic receives notifications."
