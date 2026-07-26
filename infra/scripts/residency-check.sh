#!/usr/bin/env bash
set -euo pipefail

: "${AWS_REGION:?AWS_REGION is required}"
case "$AWS_REGION" in
  ap-southeast-2|ap-southeast-4) ;;
  *) echo "non-Australian AWS region rejected: $AWS_REGION" >&2; exit 1 ;;
esac

bad="$(aws resourcegroupstaggingapi get-resources --region "$AWS_REGION" \
  --tag-filters Key=Project,Values=SubmitSense --output json \
  | jq -r '.ResourceTagMappingList[].ResourceARN' \
  | awk -F: 'NF > 3 && $4 != "" && $4 != "ap-southeast-2" && $4 != "ap-southeast-4" {print}')"

if [[ -n "$bad" ]]; then
  echo "SubmitSense resources outside the Australian allow-list:" >&2
  echo "$bad" >&2
  exit 1
fi

echo "SubmitSense tagged resources in $AWS_REGION pass the Australian region allow-list."
