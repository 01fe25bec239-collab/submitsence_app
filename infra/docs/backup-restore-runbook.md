# Backup and restore runbook

## Configured protection

- RDS automated backups and point-in-time recovery: 7/14/35 days by environment.
- AWS Backup daily encrypted RDS recovery points; production copies to Melbourne only.
- Production monthly AWS Backup restore testing selects the latest snapshot and removes the temporary
  restored resource after the validation window.
- S3 versioning on every bucket; production object replication to KMS-encrypted Melbourne buckets.

Recovery objectives remain uncommitted until product/compliance approve them. Measure actual RPO/RTO
from the first restore test; do not promise targets from configuration alone.

## Validate the monthly restore test

1. In AWS Backup, open restore testing plan `submitsense_production_monthly`.
2. Confirm the latest RDS test is `COMPLETED` and record start/end time and recovery-point ARN.
3. During an approved validation window, connect from a private maintenance task using a temporary
   least-privilege login. Check migration count, tenant counts, pgvector extension, and an RLS-denied
   cross-tenant query. Do not export row contents.
4. Record evidence in the compliance ticket and confirm AWS removed the test instance.
5. Treat missing recovery points, failed restores, or public accessibility as release blockers.

## Emergency RDS restore

1. Declare an incident, freeze deployments, and preserve CloudTrail/audit evidence.
2. Select a Sydney recovery point, or the Melbourne copy only if Sydney is unavailable.
3. Restore into the existing data subnet group with public access disabled and the database security
   group attached. Use the application KMS key in that region.
4. Run guardrail SQL against the restored instance before traffic cutover.
5. Rotate the app database secret, update the runtime secret endpoint, deploy, and monitor errors.
6. Keep the original database isolated until incident/legal owners approve disposal.

Never restore production data into dev or a non-Australian region.
