# SubmitSense AWS infrastructure

This root module provisions one isolated `dev`, `staging`, or `production` environment in Sydney
(`ap-southeast-2`). Production disaster-recovery copies go only to Melbourne (`ap-southeast-4`).
The reusable local modules are `modules/network` and `modules/storage`; `bootstrap` creates encrypted
remote state and GitHub OIDC deployment roles once per AWS account.

## Provisioning order

1. Authenticate to the intended AWS account with an administrator bootstrap role.
2. Run `terraform -chdir=terraform/bootstrap init -backend=false`, then
   `terraform -chdir=terraform/bootstrap apply -var='github_repository=OWNER/REPO'`.
   This account-level bootstrap also enables GuardDuty and Security Hub; import existing account
   resources instead of trying to create duplicates.
   Immediately migrate the local bootstrap state into its new bucket with
   `init -migrate-state -backend-config=...`, key `submitsense/bootstrap/terraform.tfstate`.
3. Copy the applicable `environments/*.backend.hcl.example`, replace the state bucket, and keep the
   resulting `.hcl` file outside source control if it contains account-specific details.
4. Copy the environment's `.tfvars.example` to `terraform.tfvars`. These files contain configuration,
   never credentials. Leave domain inputs empty until a domain is purchased.
5. Run `terraform init -backend-config=...`, `terraform plan`, and `terraform apply` from this folder.

Production without a domain deploys privately but the public ALB returns `503`. This is intentional:
production HTTP cannot be enabled, and TLS cannot be issued before DNS ownership exists.

## State and secrets

State uses an S3 backend with KMS encryption, versioning, TLS-only policy, and native S3 lockfiles.
Generated database credentials therefore exist in encrypted state and Secrets Manager, but never in
source. Stripe and approved integration secrets are populated out of band.

## Queue and scaling architecture

PostgreSQL `processing_jobs` is the authoritative asynchronous queue. SubmitSense does not depend on
Redis or BullMQ; reconsider either only for a measured future requirement. The canonical pool-to-job
mapping is `backend/src/worker-pools.json`, which Terraform reads directly. OCR, vendor, and package
pools scale from zero. The scheduled pool is the always-on PB-07 telemetry anchor and can scale above
one. Worker scale-out and scale-in are `StepScaling` policies driven by per-pool metric-math alarms over
the mapped `QueueDepth` `JobType` series. API and frontend use 60% CPU target tracking.

Application Auto Scaling owns desired counts after the baseline is created; Terraform ignores
`desired_count` and service `task_definition` drift. To change a baseline, review and apply the tfvars
change, then explicitly set the ECS desired count inside the new bounds. Application Auto Scaling
resumes from that value. Never suspend scaling during deployment.

The plan-time database gate budgets the API at 200% of its maximum task count, every worker at 200% of
its maximum with a three-connection pool, and one migration connection. Required/planned/80%-usable
totals are dev `61/112/89`, staging `115/450/360`, and production `297/1802/1441`. Deployment repeats
the check against live `SHOW max_connections` from a one-off task in the application VPC before
migrations.

Do not commit `.tfvars`, backend configuration containing account data, plans, or state.

## Validation

```bash
terraform fmt -check -recursive terraform
terraform -chdir=terraform init -backend=false
terraform -chdir=terraform validate
terraform -chdir=terraform/bootstrap init -backend=false
terraform -chdir=terraform/bootstrap validate
infra/scripts/static-infra-check.sh
```

Operational procedures live in [`../infra/docs/`](../infra/docs/).
