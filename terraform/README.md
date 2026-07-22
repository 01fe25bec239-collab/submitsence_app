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

## Queue architecture and removal impact

PostgreSQL `processing_jobs` is the authoritative asynchronous queue. SubmitSense does not currently
depend on Redis or BullMQ; reconsider either only for a measured future requirement. Queue metrics are
deferred to PB-07 and worker autoscaling to PB-08.

Applying this change to an existing environment destroys the ElastiCache replication group, its subnet
and security groups, its secret/version, and its alarms; Secrets Manager deletion follows the configured
recovery window. Apply and check staging first: confirm no runtime task consumes Redis configuration,
review the Terraform plan, and verify only those intended resources are destroyed. Production apply
requires explicit approval after that review. Because bootstrap state owns the deployment-role policy,
apply its ElastiCache permission removal only after the environment resources have been removed.

Do not commit `.tfvars`, backend configuration containing account data, plans, or state.

## Validation

```bash
terraform fmt -check -recursive terraform
terraform -chdir=terraform init -backend=false
terraform -chdir=terraform validate
infra/scripts/static-infra-check.sh
```

Operational procedures live in [`../infra/docs/`](../infra/docs/).
