# Incident response runbook

For suspected disclosure, preserve evidence and stop before drafting customer/regulator language;
legal/product own notification decisions under the NDB process.

## Suspected breach

1. Open an incident ID; restrict access and freeze deletion/lifecycle changes.
2. Contain the affected role, task, integration, bucket key prefix, or security-group path.
3. Preserve CloudTrail validation files, WAF blocks, VPC rejects, ECS logs, RDS snapshot, audit-event
   range, and relevant S3 versions under legal hold. Do not copy document bodies into the ticket.
4. Use audit identifiers and timestamps to determine affected tenants/data categories.
5. Rotate credentials, patch the control, validate tenant isolation, and obtain incident-owner approval
   before restoring traffic.

## Failed deployment

Allow the ECS circuit breaker to roll back, then follow the deployment rollback procedure. If the
migration failed, do not deploy the new application. Inspect only migration filenames/errors, repair
forward, and rerun. Never edit production migration history to make a failure disappear.

## Queue backlog or failed workers

Check queue-depth/custom failure alarms, ECS desired/running counts, RDS connections, and worker logs.
Inspect the affected pool's metric-math alarm and Application Auto Scaling activity before manually
scaling it. Preserve idempotency keys; never bulk-reset `running` jobs without identifying crashed
tasks and the safe retry window. If all workers are zero and telemetry is missing, restore
`worker-scheduled` to desired count one; do not enable non-Australian endpoints to clear a backlog.

## Compromised secret

Disable the affected integration/app capability, create a new Secrets Manager version, revoke the old
provider credential, force an ECS deployment, and verify CloudTrail access history. Rotate the KMS key
only when key compromise is suspected; routine secret rotation does not require replacing the key.
Never paste old or new secret values into logs, chat, issues, or audit payloads.
