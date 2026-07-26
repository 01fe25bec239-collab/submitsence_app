# QA and compliance handoff

## Automated evidence

- `terraform validate` against AWS provider 6.x.
- `infra/scripts/static-infra-check.sh`: Australian regions, encryption, private RDS, production HTTP
  block, and committed-secret patterns.
- Backend/frontend tests, type checks, lint, dependency audit, and container builds in CI.
- ECR high/critical image-scan gate before deployment.
- Live in-VPC database-capacity and migration exit-code gates plus bounded ECS rollout polling.
- Manual alert-simulation workflow and AWS Backup monthly restore testing.

## Release blockers still owned outside infrastructure

- No domain exists. Production public access returns `503` until Route 53/ACM inputs are supplied.
- The API's current hand-built S3 signer expects static `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`.
  Infrastructure intentionally supplies only task-role credentials; backend must use the AWS credential
  provider/presigner before production uploads work.
- PostgreSQL `processing_jobs` is the sole active asynchronous queue. PB-07 emits queue metrics and
  PB-08 scales canonical OCR/vendor/package/scheduled pools without Redis or BullMQ.
- Textract permissions/endpoints exist, but unsupported OCR ingestion and RFI-PDF export jobs remain disabled until production consumers exist.
- Aconex/Procore `package_push` and `response_pull` jobs remain disabled pending production consumers, partner approval, and official adapters.
- Real frontend Cognito sign-in/cookie handling, token revocation, and post-confirmation user-link trigger
  remain application gaps.
- Stripe secret values, price IDs, legal terms/privacy versions, retention periods, production alarm
  recipient, and GitHub repository/account configuration require owner input.

Do not mark staging/production acceptance complete until the relevant gaps are resolved and the runtime
residency, restore, worker, and alert evidence has been captured.
